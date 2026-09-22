import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** The lock's `at`, or 0 when it cannot be read or has none; throws ENOENT when it is gone. */
function readAt(path: string): number {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
    return 0
  }
  try {
    return Number((JSON.parse(text) as { at?: unknown }).at) || 0
  } catch {
    return 0
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
 * `afterRename` is a test seam that runs between the rename and the re-read.
 */
export function takeLock(
  dir: string,
  now: number,
  afterRename?: (renamed: string) => void,
): boolean {
  const path = join(dir, LOCK_FILE)
  const mine = uniquePath(path, 'new')
  writeFileSync(mine, JSON.stringify({ pid: process.pid, at: now }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, path)
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
      afterRename?.(stale)
      if (readAt(stale) !== at) {
        // Not the lock judged stale: put it back unless a newer one is already there.
        try {
          linkSync(stale, path)
        } catch {
          // Another lock holds the name; it is the one in force.
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
