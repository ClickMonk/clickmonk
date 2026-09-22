import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
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
  /**
   * Unique to this writer. In a container the redirect restarts with the
   * same PID every time, so PID and sequence alone would name the new
   * writer's open segment after one its predecessor left behind.
   */
  private readonly runId = randomUUID().slice(0, 8)
  private dirty = false
  private sealedBytes = 0
  private dropped = 0
  private lastMeasureAt = 0
  private timer: NodeJS.Timeout | null = null
  private closed = false
  /**
   * Paths of segments that were written, fsynced and closed, but whose
   * rename to their sealed name failed. A set, not a single slot: a second
   * failure while a first is still pending must not forget the first.
   * Every entry is retried on each tick until it succeeds, rather than
   * being left as an orphaned `.part` file, invisible to the worker and to
   * `measureSealed`, until the next `start()`.
   */
  private readonly pendingSeals = new Set<string>()

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
    this.lastMeasureAt = Date.now()
    this.timer = setInterval(() => this.tick(), this.fsyncIntervalMs)
    this.timer.unref()
  }

  /** True when the record is written. Never throws. */
  append(record: ClickRecord): boolean {
    if (this.closed) {
      this.dropped++
      return false
    }
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
      // The record is accepted from here on: it is on disk. A failure
      // sealing the segment (fsync, close or rename) is reported through
      // onError, never by dropping this record or returning false for it.
      if (this.segBytes >= this.maxSegmentBytes) {
        try {
          this.seal()
        } catch (err) {
          this.onError(err)
        }
      }
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

  /**
   * Stops the timer and seals the open segment. Call on shutdown, after the
   * server stops accepting. After this, `append` returns false and counts a
   * drop, rather than opening a segment no timer is left to seal.
   */
  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.retryPendingSeals()
    try {
      if (this.fd !== null) this.seal()
    } catch (err) {
      this.onError(err)
    }
  }

  private tick(): void {
    try {
      this.retryPendingSeals()
      if (this.fd !== null && this.dirty) {
        fsyncSync(this.fd)
        this.dirty = false
      }
      if (this.fd !== null && Date.now() - this.segOpenedAt >= this.maxSegmentAgeMs) this.seal()
      // The worker deletes shipped segments; re-measure roughly once a
      // second, by elapsed time rather than a count of ticks, so a timer
      // that runs late or drifts under load still re-measures promptly
      // instead of needing an exact number of ticks to land.
      if (Date.now() - this.lastMeasureAt >= 1000) {
        this.lastMeasureAt = Date.now()
        this.sealedBytes = this.measureSealed()
      }
    } catch (err) {
      this.onError(err)
    }
  }

  private openSegment(): void {
    this.openPath = join(this.dir, `open-${process.pid}-${this.runId}-${this.seq++}.part`)
    this.fd = openSync(this.openPath, 'a')
    this.segBytes = 0
    this.segOpenedAt = Date.now()
  }

  private seal(): void {
    const fd = this.fd as number
    const path = this.openPath
    const bytes = this.segBytes
    this.fd = null
    this.dirty = false
    this.segBytes = 0
    // The bytes are on disk and count toward the total from here regardless
    // of what happens next; only the name, and so the worker's visibility
    // of the segment, is at risk below.
    this.sealedBytes += bytes
    try {
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      this.renameToSealed(path)
    } catch (err) {
      this.pendingSeals.add(path)
      throw err
    }
  }

  /**
   * Retries every pending rename, not only the most recent one. Each is its
   * own try/catch: one still-failing rename must not stop the others from
   * being retried, and only a rename that succeeds is removed from the set.
   */
  private retryPendingSeals(): void {
    for (const path of [...this.pendingSeals]) {
      try {
        this.renameToSealed(path)
        this.pendingSeals.delete(path)
      } catch (err) {
        this.onError(err)
      }
    }
  }

  /**
   * `renameSync` replaces an existing file, so a name already taken is
   * skipped rather than overwritten: a previous writer with this PID may
   * have sealed a segment under the same name in the same millisecond.
   * Checking first is safe because one process owns the directory.
   */
  private renameToSealed(path: string): void {
    let target: string
    do target = join(this.dir, segmentName(Date.now(), process.pid, this.seq++))
    while (existsSync(target))
    renameSync(path, target)
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
    for (const path of this.pendingSeals) {
      try {
        total += statSync(path).size
      } catch {
        // Renamed by a retry, or removed, between check and stat.
      }
    }
    return total
  }
}
