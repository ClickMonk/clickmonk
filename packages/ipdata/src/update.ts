import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  SOURCES,
  SOURCE_IDS,
  type SourceDef,
  type SourceId,
  checkMinimum,
  contentVersion,
} from './sources.js'
import { type TableUpdate, commitTables, isIoError, readManifest } from './store.js'

export type FetchResult = { status: 'ok'; body: Uint8Array } | { status: 'not_found' }
export type Fetcher = (
  url: string,
  opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
) => Promise<FetchResult>

/**
 * One download, bounded in size and in time, and abandoned when `signal`
 * aborts. A 404 is an answer, not an error: a DB-IP edition may not be out yet.
 */
export const fetchBounded: Fetcher = async (url, { maxBytes, timeoutMs, signal }) => {
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    headers: { 'user-agent': 'ClickMonk IP data updater' },
  })
  if (res.status === 404) {
    await res.body?.cancel()
    return { status: 'not_found' }
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`${url}: HTTP ${res.status}`)
  }
  // Refused before reading when the server says so; checked again while
  // reading, because a server need not say.
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > maxBytes) {
    await res.body?.cancel()
    throw new Error(`${url}: declares ${declared} bytes, over the bound of ${maxBytes}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (res.body) {
    for await (const chunk of res.body) {
      total += chunk.byteLength
      // Leaving the loop cancels the rest of the body.
      if (total > maxBytes) throw new Error(`${url}: larger than ${maxBytes} bytes`)
      chunks.push(chunk)
    }
  }
  return { status: 'ok', body: Buffer.concat(chunks) }
}

export type UpdateOutcome = 'updated' | 'unchanged' | 'not_due' | 'failed'
export interface SourceResult {
  id: SourceId
  outcome: UpdateOutcome
  version?: string
  error?: string
}

export interface UpdateOptions {
  dir: string
  now?: () => Date
  fetch?: Fetcher
  /** Default: every source. Tests pass smaller minimums. */
  sources?: SourceDef[]
  /** Download whatever is not current, however recently it was fetched. */
  force?: boolean
  /**
   * When each source was last found unchanged, by the caller that runs
   * updates repeatedly. Read and written: it spares a download that the
   * last check already found to hold nothing new.
   */
  checked?: Map<SourceId, number>
  timeoutMs?: number
  /** Aborts the download in flight and starts no other; the lock is still released. */
  signal?: AbortSignal
}

const LOCK_FILE = 'update.lock'
/** A lock older than this was left by a process that died; no update runs this long. */
export const LOCK_STALE_MS = 30 * 60_000

/** True when this process now holds the lock. */
function takeLock(dir: string, now: number): boolean {
  const path = join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }))
      closeSync(fd)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let at = 0
      try {
        at = Number((JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown }).at) || 0
      } catch {
        // Unreadable: treat as stale.
      }
      if (now - at < LOCK_STALE_MS) return false
      rmSync(path, { force: true })
    }
  }
  return false
}

async function updateOne(
  def: SourceDef,
  current: { version: string } | undefined,
  o: Required<Pick<UpdateOptions, 'fetch' | 'timeoutMs'>> & Pick<UpdateOptions, 'signal'>,
  now: Date,
): Promise<{ result: SourceResult; update?: TableUpdate }> {
  for (const candidate of def.candidates(now)) {
    if (candidate.version !== null && candidate.version === current?.version) {
      return { result: { id: def.id, outcome: 'unchanged', version: current.version } }
    }
    const res = await o.fetch(candidate.url, {
      maxBytes: def.gzip ? def.maxDownloadBytes : Math.min(def.maxDownloadBytes, def.maxTextBytes),
      timeoutMs: o.timeoutMs,
      ...(o.signal ? { signal: o.signal } : {}),
    })
    if (res.status === 'not_found') continue
    const version = candidate.version ?? contentVersion(res.body)
    if (version === current?.version) {
      return { result: { id: def.id, outcome: 'unchanged', version } }
    }
    // A plain download is its text, so it is held to maxTextBytes as well
    // (checked here too, since a fetcher need not honour maxBytes); a
    // compressed one is refused as soon as it unpacks past maxTextBytes.
    if (!def.gzip && res.body.byteLength > def.maxTextBytes) {
      throw new Error(`${def.id}: larger than ${def.maxTextBytes} bytes`)
    }
    const raw = def.gzip ? gunzipSync(res.body, { maxOutputLength: def.maxTextBytes }) : res.body
    const table = def.parse(
      Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8'),
      def.limits,
    )
    checkMinimum(def.id, table, def.minimum)
    return {
      result: { id: def.id, outcome: 'updated', version },
      update: { table, version, fetchedAt: now },
    }
  }
  throw new Error('no edition published at any of the expected addresses')
}

/**
 * Downloads every source that is due, validates it, and installs the ones
 * that pass in a single manifest write. A source that fails keeps the table
 * it had; it never stops the others. Returns 'busy' when another update
 * holds the lock. Never touches the network for a source that is not due.
 */
export async function runUpdate(opts: UpdateOptions): Promise<SourceResult[] | 'busy'> {
  const now = (opts.now ?? (() => new Date()))()
  const o = {
    fetch: opts.fetch ?? fetchBounded,
    timeoutMs: opts.timeoutMs ?? 120_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  if (!takeLock(opts.dir, now.getTime())) return 'busy'
  try {
    // An I/O error reading the manifest aborts the run before any download,
    // the same split commitTables makes. A manifest that reads but is not
    // valid counts as none: every source is due, and the commit replaces it.
    let manifest: ReturnType<typeof readManifest>
    try {
      manifest = readManifest(opts.dir)
    } catch (err) {
      if (isIoError(err)) throw err
      manifest = null
    }
    const results: SourceResult[] = []
    const updates: Partial<Record<SourceId, TableUpdate>> = {}
    for (const def of opts.sources ?? SOURCE_IDS.map((id) => SOURCES[id])) {
      // Stopping: start no other download. What already passed is still installed.
      if (opts.signal?.aborted) break
      const current = manifest?.sources[def.id]
      const last = Math.max(
        current ? Date.parse(current.fetchedAt) : 0,
        opts.checked?.get(def.id) ?? 0,
      )
      if (!opts.force && current && now.getTime() - last < def.refreshMs) {
        results.push({ id: def.id, outcome: 'not_due', version: current.version })
        continue
      }
      try {
        const { result, update } = await updateOne(def, current, o, now)
        results.push(result)
        if (update) updates[def.id] = update
        if (result.outcome === 'unchanged') opts.checked?.set(def.id, now.getTime())
      } catch (err) {
        results.push({
          id: def.id,
          outcome: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (Object.keys(updates).length > 0) commitTables(opts.dir, updates)
    return results
  } finally {
    rmSync(join(opts.dir, LOCK_FILE), { force: true })
  }
}

/** Runs `runUpdate` now and then every `intervalMs`. The promise of `stop()` resolves after the run in flight. Never rejects. */
export function startUpdater(opts: {
  dir: string
  intervalMs?: number
  fetch?: Fetcher
  sources?: SourceDef[]
  log?: (msg: string, err?: unknown) => void
}): { stop(): Promise<void> } {
  const interval = opts.intervalMs ?? 3_600_000
  const log = opts.log ?? (() => {})
  const checked = new Map<SourceId, number>()
  // Aborts a download in flight on stop(), so the lock is released at once.
  const abort = new AbortController()
  let stopped = false
  let wake: (() => void) | null = null

  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await runUpdate({
          dir: opts.dir,
          checked,
          signal: abort.signal,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
          ...(opts.sources ? { sources: opts.sources } : {}),
        })
        if (r === 'busy') log('IP data update skipped: another update holds the lock')
        else {
          for (const s of r) {
            if (s.outcome === 'updated') log(`IP data ${s.id} updated to ${s.version}`)
            if (s.outcome === 'failed')
              log(`IP data ${s.id} update failed; keeping the table in use: ${s.error}`)
          }
        }
      } catch (err) {
        log('IP data update failed', err)
      }
      if (stopped) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, interval)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wake = null
    }
  })()

  return {
    async stop() {
      stopped = true
      abort.abort()
      wake?.()
      await loop
    },
  }
}
