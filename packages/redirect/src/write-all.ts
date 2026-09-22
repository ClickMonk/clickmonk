import { writeSync } from 'node:fs'

/** The shape of `fs.writeSync` with a buffer; a seam for tests. */
export type WriteFn = (fd: number, buf: Uint8Array, offset: number, length: number) => number

/**
 * Writes every byte of `buf`. `writeSync` may write fewer bytes than asked
 * (a file size limit, a full disk) and says so only through its return
 * value, so a single call can leave half a record on disk and report
 * nothing. This loops over short writes and throws when a call makes no
 * progress. `progress.written` holds the bytes written so far, including
 * when it throws, so the caller can undo a partial write.
 */
export function writeAll(
  fd: number,
  buf: Uint8Array,
  write: WriteFn = writeSync,
  progress: { written: number } = { written: 0 },
): void {
  progress.written = 0
  while (progress.written < buf.length) {
    const n = write(fd, buf, progress.written, buf.length - progress.written)
    if (!(n > 0)) {
      throw new Error(`write made no progress after ${progress.written} of ${buf.length} bytes`)
    }
    progress.written += n
  }
}
