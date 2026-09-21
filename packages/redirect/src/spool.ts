import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { type ClickRecord, SEALED_SEGMENT_RE, segmentName } from '@clickmonk/core'

export interface SpoolOptions {
  dir: string
  /** Seal a segment at this size. Default 8 MB. */
  maxSegmentBytes?: number
  /** Seal a non-empty segment at this age, so reports lag by seconds. Default 2 s. */
  maxSegmentAgeMs?: number
  /** fsync cadence; bounds what a power loss can take. Default 200 ms. */
  fsyncIntervalMs?: number
  /** Stop writing (and count drops) above this many bytes on disk. Default 5 GB. */
  maxTotalBytes?: number
  onError?: (err: unknown) => void
}

/**
 * Append-only click log between the redirect and the worker. A click is
 * accepted once `append` returns, before the visitor gets a response.
 * Single writer per directory: one redirect process owns it.
 */
export class SpoolWriter {
  private readonly dir: string
  private readonly maxSegmentBytes: number
  private readonly maxSegmentAgeMs: number
  private readonly fsyncIntervalMs: number
  private readonly maxTotalBytes: number
  private readonly onError: (err: unknown) => void

  private fd: number | null = null
  private openPath = ''
  private segBytes = 0
  private segOpenedAt = 0
  private seq = 0
  private dirty = false
  private sealedBytes = 0
  private dropped = 0
  private ticks = 0
  private timer: NodeJS.Timeout | null = null

  constructor(opts: SpoolOptions) {
    this.dir = opts.dir
    this.maxSegmentBytes = opts.maxSegmentBytes ?? 8 * 1024 * 1024
    this.maxSegmentAgeMs = opts.maxSegmentAgeMs ?? 2000
    this.fsyncIntervalMs = opts.fsyncIntervalMs ?? 200
    this.maxTotalBytes = opts.maxTotalBytes ?? 5 * 1024 * 1024 * 1024
    this.onError = opts.onError ?? (() => {})
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true })
    // A writer that crashed left its segment open. Its lines are complete up
    // to the last newline; the worker skips a torn final line.
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith('.part')) this.renameToSealed(join(this.dir, f))
    }
    this.sealedBytes = this.measureSealed()
    this.timer = setInterval(() => this.tick(), this.fsyncIntervalMs)
    this.timer.unref()
  }

  /** True when the record is written. Never throws. */
  append(record: ClickRecord): boolean {
    try {
      const line = `${JSON.stringify(record)}\n`
      const n = Buffer.byteLength(line)
      if (this.sealedBytes + this.segBytes + n > this.maxTotalBytes) {
        this.dropped++
        return false
      }
      if (this.fd === null) this.openSegment()
      writeSync(this.fd as number, line)
      this.segBytes += n
      this.dirty = true
      if (this.segBytes >= this.maxSegmentBytes) this.seal()
      return true
    } catch (err) {
      this.dropped++
      this.onError(err)
      return false
    }
  }

  stats(): { dropped: number; pendingBytes: number } {
    return { dropped: this.dropped, pendingBytes: this.sealedBytes + this.segBytes }
  }

  /** Stops the timer and seals the open segment. Call on shutdown, after the server stops accepting. */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      if (this.fd !== null) this.seal()
    } catch (err) {
      this.onError(err)
    }
  }

  private tick(): void {
    try {
      if (this.fd !== null && this.dirty) {
        fsyncSync(this.fd)
        this.dirty = false
      }
      if (this.fd !== null && Date.now() - this.segOpenedAt >= this.maxSegmentAgeMs) this.seal()
      // The worker deletes shipped segments; re-measure about once a second so
      // a full spool starts accepting again after it drains.
      this.ticks++
      if (this.ticks * this.fsyncIntervalMs >= 1000) {
        this.ticks = 0
        this.sealedBytes = this.measureSealed()
      }
    } catch (err) {
      this.onError(err)
    }
  }

  private openSegment(): void {
    this.openPath = join(this.dir, `open-${process.pid}-${this.seq++}.part`)
    this.fd = openSync(this.openPath, 'a')
    this.segBytes = 0
    this.segOpenedAt = Date.now()
  }

  private seal(): void {
    const fd = this.fd as number
    this.fd = null
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.dirty = false
    this.renameToSealed(this.openPath)
    this.sealedBytes += this.segBytes
    this.segBytes = 0
  }

  private renameToSealed(path: string): void {
    renameSync(path, join(this.dir, segmentName(Date.now(), process.pid, this.seq++)))
  }

  private measureSealed(): number {
    let total = 0
    for (const f of readdirSync(this.dir)) {
      if (!SEALED_SEGMENT_RE.test(f)) continue
      try {
        total += statSync(join(this.dir, f)).size
      } catch {
        // Deleted by the worker between readdir and stat.
      }
    }
    return total
  }
}
