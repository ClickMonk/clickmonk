import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type IpFacts, NO_IP_FACTS } from '@clickmonk/core'
import { z } from 'zod'
import { parseIp } from './ip.js'
import { SOURCES, SOURCE_IDS, type SourceId } from './sources.js'
import { RangeTable, type TableLimits, tableBytes, unpackCountry } from './table.js'

export const DEFAULT_IPDATA_DIR = '/var/lib/clickmonk/ipdata'
export const MANIFEST_FILE = 'manifest.json'
export const MAX_MANIFEST_BYTES = 64 * 1024
const TABLE_FILE_RE = /^(country|asn|datacenter|tor)-[0-9a-f]{16}\.cmrt$/

const SourceEntrySchema = z
  .object({
    file: z.string().regex(TABLE_FILE_RE),
    version: z.string().min(1).max(64),
    fetchedAt: z.string().datetime(),
    entries: z.object({ k32: z.number().int().min(0), k128: z.number().int().min(0) }),
  })
  .strict()

/**
 * The one file the redirect watches. It names the table file in use for each
 * source; table files are named by their content and never rewritten, so a
 * reader that has the manifest can always read the files it names.
 */
const ManifestSchema = z
  .object({
    v: z.literal(1),
    sources: z
      .object({
        country: SourceEntrySchema,
        asn: SourceEntrySchema,
        datacenter: SourceEntrySchema,
        tor: SourceEntrySchema,
      })
      .partial()
      .strict(),
  })
  .strict()

export type SourceEntry = z.infer<typeof SourceEntrySchema>
export type Manifest = z.infer<typeof ManifestSchema>

/** The largest file a table within `limits` can be. */
export function maxTableBytes(limits: TableLimits): number {
  return tableBytes(limits.max32, limits.max128)
}

/**
 * Null when there is no manifest yet. Throws when there is one and it is
 * over its bound (checked by size before a byte is read) or not valid. The
 * one reader of the manifest: the updater and the redirect's loader both
 * call it.
 */
export function readManifest(dir: string): Manifest | null {
  const path = join(dir, MANIFEST_FILE)
  if (!existsSync(path)) return null
  const size = statSync(path).size
  if (size > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest is ${size} bytes, over the bound of ${MAX_MANIFEST_BYTES} bytes`)
  }
  return ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** Every byte to a temporary file, fsync, rename: a reader sees the old file or the new one. */
export function writeFileAtomic(path: string, bytes: Uint8Array | string): void {
  const tmp = `${path}.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Makes a directory's own entries durable. A file's own fsync (in
 * `writeFileAtomic`) only guarantees its content; the rename that gives it
 * its final name is a change to the directory, which needs its own fsync or
 * a crash can lose the rename even though the file's bytes survive.
 */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export interface TableUpdate {
  table: RangeTable
  version: string
  fetchedAt: Date
}

/** A Node fs error (EACCES, EIO, EISDIR, EMFILE, …) carries a string `code`; a parse or schema failure (SyntaxError, ZodError, the size-bound Error) does not. */
function isIoError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
  )
}

/**
 * Writes each new table under a name taken from its content, then the
 * manifest naming them, then removes every table file that neither this
 * manifest nor the one it replaced names. Keeping the replaced manifest's
 * files lets a reader that read it a moment ago still open them. The caller
 * holds the update lock: two writers would each remove the other's files.
 *
 * `readManifest` returns null only when there is no manifest file yet.
 * Any other failure splits in two: an I/O error (a directory in the
 * manifest's place, a permission or read error — it has a `code`) is
 * rethrown, aborting before anything is written, since guessing wrong here
 * would drop every other source and the cleanup pass would then delete
 * their files. A manifest that is merely unreadable *as one* — bad JSON, a
 * schema this build does not know (for instance `v` from a version this
 * build predates), or over its size bound — is instead treated as absent:
 * the alternative is that one bad manifest stops every future update
 * forever. This turn's cleanup pass is skipped in that case, because
 * without the old manifest there is no way to tell which files besides the
 * ones just written it is still safe to remove; the next commit, once
 * there is a real previous manifest to compare against, removes whatever
 * this turn left behind.
 */
export function commitTables(
  dir: string,
  updates: Partial<Record<SourceId, TableUpdate>>,
): Manifest {
  let previous: Manifest | null
  let cleanUp = true
  try {
    previous = readManifest(dir)
  } catch (err) {
    if (isIoError(err)) throw err
    previous = null
    cleanUp = false
  }
  const sources: Manifest['sources'] = { ...previous?.sources }
  for (const id of SOURCE_IDS) {
    const u = updates[id]
    if (!u) continue
    const bytes = u.table.encode()
    const file = `${id}-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.cmrt`
    if (!existsSync(join(dir, file))) writeFileAtomic(join(dir, file), bytes)
    sources[id] = {
      file,
      version: u.version,
      fetchedAt: u.fetchedAt.toISOString(),
      entries: u.table.size,
    }
  }
  // The renames above are durable before the manifest that names them is
  // written, so a crash between the two never leaves the manifest pointing
  // at a file the directory does not yet durably have.
  fsyncDir(dir)
  const next: Manifest = { v: 1, sources }
  writeFileAtomic(join(dir, MANIFEST_FILE), JSON.stringify(next))

  if (cleanUp) {
    const keep = new Set(
      [next, previous].flatMap((m) => Object.values(m?.sources ?? {}).map((s) => s.file)),
    )
    for (const f of readdirSync(dir)) {
      if ((TABLE_FILE_RE.test(f) && !keep.has(f)) || f.endsWith('.tmp'))
        rmSync(join(dir, f), { force: true })
    }
  }
  return next
}

/** Anything that answers IP facts; the redirect depends on this, not on the store. */
export interface IpLookup {
  lookup(ip: string): IpFacts
}

/** One consistent set of loaded tables. Immutable. */
export class IpData implements IpLookup {
  constructor(
    readonly tables: Partial<Record<SourceId, RangeTable>>,
    readonly versions: Partial<Record<SourceId, string>>,
  ) {}

  /**
   * Synchronous and bounded: a parse of at most 45 characters and one binary
   * search per table. A field whose table is not loaded is null, and so is
   * every field for a string that is not an address.
   */
  lookup(ip: string): IpFacts {
    const p = parseIp(ip)
    if (!p) return NO_IP_FACTS
    const get = (t: RangeTable | undefined): number | null =>
      t === undefined ? null : p.v === 4 ? t.get32(p.n) : t.get128(p.w)
    const { country, asn, datacenter, tor } = this.tables
    const code = get(country)
    const asnValue = get(asn)
    return {
      country: code === null ? null : unpackCountry(code),
      asn: asnValue,
      tor: tor ? get(tor) !== null : null,
      datacenter:
        asn && datacenter ? asnValue !== null && datacenter.get32(asnValue) !== null : null,
      geoSource: country ? `${SOURCES.country.name}/${this.versions.country ?? ''}` : '',
    }
  }
}

export interface IpDataStoreOptions {
  dir: string
  /** How often the manifest is checked for a change. Default 30 s. */
  pollMs?: number
  log?: (msg: string, err?: unknown) => void
}

export interface SourceStatus {
  id: SourceId
  version: string
  fetchedAt: string
  entries: { k32: number; k128: number }
}

/**
 * The redirect's copy of the IP data. Reads only: the worker writes. Loads
 * the tables whole into memory, off the request path, and swaps the set in
 * one assignment, so a lookup never sees half an update. A source whose
 * file cannot be read keeps the table it had, if any.
 */
export class IpDataStore {
  private data: IpData | null = null
  private loaded: Partial<Record<SourceId, SourceEntry>> = {}
  private inFlight: Promise<boolean> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly o: Required<IpDataStoreOptions>

  constructor(opts: IpDataStoreOptions) {
    this.o = { pollMs: 30_000, log: () => {}, ...opts }
  }

  current(): IpData | null {
    return this.data
  }

  status(): SourceStatus[] {
    return SOURCE_IDS.flatMap((id) => {
      const e = this.loaded[id]
      return e ? [{ id, version: e.version, fetchedAt: e.fetchedAt, entries: e.entries }] : []
    })
  }

  /** A second call while already started is a no-op: it neither reloads nor starts a second timer. Call `stop()` first to restart. */
  async start(): Promise<void> {
    if (this.timer) return
    await this.refresh()
    if (!this.data)
      this.safeLog('no IP data yet: countries are unknown and the IP checks do not run')
    this.timer = setInterval(() => void this.refresh(), this.o.pollMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * `refresh()` promises never to reject, including when the caller's own
   * `log` throws — the interval below calls it fire-and-forget, so a
   * rejection there would be an unhandled rejection, not a caught error.
   */
  private safeLog(msg: string, err?: unknown): void {
    try {
      this.o.log(msg, err)
    } catch {
      // A broken logger must not take the store down.
    }
  }

  /**
   * Loads every table the manifest names that is not the one already
   * loaded, so a table that failed to load is tried again on the next call.
   * True when a new set of tables was applied. Never rejects. A call made
   * while one is running shares it, so an older load can never finish after
   * a newer one and replace its tables.
   */
  refresh(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.load().finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async load(): Promise<boolean> {
    // At most 64 KB, read synchronously; the tables below are read async.
    let manifest: Manifest | null
    try {
      manifest = readManifest(this.o.dir)
    } catch (err) {
      this.safeLog('could not read the IP data manifest; keeping what is loaded', err)
      return false
    }
    if (!manifest) return false

    const tables: Partial<Record<SourceId, RangeTable>> = { ...this.data?.tables }
    const loaded: Partial<Record<SourceId, SourceEntry>> = { ...this.loaded }
    let changed = 0
    for (const id of SOURCE_IDS) {
      const entry = manifest.sources[id]
      // No entry means this source is not in the manifest — removed, or not
      // yet written — not "failed to load"; the table already loaded for it,
      // if any, is carried over above and left exactly as it was.
      if (!entry || entry.file === this.loaded[id]?.file) continue
      try {
        const path = join(this.o.dir, entry.file)
        const max = maxTableBytes(SOURCES[id].limits)
        if ((await stat(path)).size > max)
          throw new Error(`${entry.file} is over the bound of ${max} bytes`)
        tables[id] = RangeTable.decode(SOURCES[id].kind, await readFile(path), SOURCES[id].limits)
        loaded[id] = entry
        changed++
      } catch (err) {
        this.safeLog(`could not load IP data ${id}; keeping the table in use`, err)
      }
    }
    if (changed === 0) return false
    const versions = Object.fromEntries(
      Object.entries(loaded).map(([id, e]) => [id, (e as SourceEntry).version]),
    )
    this.data = new IpData(tables, versions)
    this.loaded = loaded
    return true
  }
}
