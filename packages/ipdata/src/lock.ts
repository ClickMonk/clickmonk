import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const LOCK_FILE = 'update.lock'
/** A lock older than this was left by a process that died; no update runs this long. */
export const LOCK_STALE_MS = 30 * 60_000

let seq = 0
/** A name no other process or call uses, next to the lock. */
function uniquePath(path: string, tag: string): string {
  seq++
  return `${path}.${tag}-${process.pid}-${Date.now()}-${seq}`
}

/**
 * The lock's `at`. A lock without one (half written, where the lock had to
 * be created in place) is as old as its file, so one being written right
 * now is not taken for stale. 0 when it cannot be read; throws ENOENT when
 * it is gone.
 */
function readAt(path: string): number {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
    return 0
  }
  try {
    const at = Number((JSON.parse(text) as { at?: unknown }).at)
    if (at > 0) return at
  } catch {
    // Not JSON: dated by the file below.
  }
  try {
    return statSync(path).mtimeMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
    return 0
  }
}

/** A filesystem without hard links (some network and FUSE ones) answers `link` with one of these. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'])
/** Data directories already reported as lacking hard links, so each is logged once. */
const noLinksLogged = new Set<string>()

export interface LockOptions {
  /** Test seam: runs between renaming a stale lock and reading it again. */
  afterRename?: (renamed: string) => void
  /** Test seam: stands in for `fs.linkSync`. */
  link?: (existing: string, target: string) => void
  log?: (msg: string) => void
}

/**
 * Gives `target` the content of `src` without replacing an existing file:
 * throws EEXIST when `target` exists. A hard link does it in one step; where
 * the filesystem has none, the file is created exclusively and then written.
 */
function place(src: string, target: string, dir: string, o: LockOptions): void {
  try {
    ;(o.link ?? linkSync)(src, target)
    return
  } catch (err) {
    if (!NO_LINKS.has((err as NodeJS.ErrnoException).code ?? '')) throw err
  }
  if (!noLinksLogged.has(dir)) {
    noLinksLogged.add(dir)
    o.log?.(`IP data directory ${dir} has no hard links; the update lock is created in place`)
  }
  const bytes = readFileSync(src)
  const fd = openSync(target, 'wx')
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

/**
 * True when this process now holds the lock. The lock is written in full
 * to a private file and linked into place, so it never exists half written.
 *
 * A stale lock is taken over by renaming it to a name only this call uses
 * and reading it again: if it still holds the stale time read before, it is
 * the dead process's lock and is removed. If it holds another time, another
 * process took the lock over in between, and this call renamed that live
 * lock: it is linked back into place and this call backs off.
 */
export function takeLock(dir: string, now: number, o: LockOptions = {}): boolean {
  const path = join(dir, LOCK_FILE)
  const mine = uniquePath(path, 'new')
  writeFileSync(mine, JSON.stringify({ pid: process.pid, at: now }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        place(mine, path, dir, o)
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      let at: number
      try {
        at = readAt(path)
      } catch {
        continue // Released in between: try again.
      }
      if (now - at < LOCK_STALE_MS) return false
      const stale = uniquePath(path, 'stale')
      try {
        renameSync(path, stale)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      o.afterRename?.(stale)
      if (readAt(stale) !== at) {
        // Not the lock judged stale: put it back unless a newer one is already there.
        try {
          place(stale, path, dir, o)
        } catch (err) {
          // Another lock holds the name; it is the one in force.
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
        rmSync(stale, { force: true })
        return false
      }
      rmSync(stale, { force: true })
    }
    return false
  } finally {
    rmSync(mine, { force: true })
  }
}

export function releaseLock(dir: string): void {
  rmSync(join(dir, LOCK_FILE), { force: true })
}
