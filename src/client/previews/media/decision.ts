/** Choosing between streaming and buffering when the platform hides the size. */
import { LIMITS } from '../../../shared/limits.ts'

/** Largest file pulled into memory to restore seeking. */
export const MAX_BUFFER_BYTES = LIMITS.mediaBuffer

/**
 * Decide what to do when the platform reports no seekable range.
 *
 * Chromium answers an unknown-length stream with `seekable = [0, 0]`, which is
 * what the desktop shell's forwarding proxy produces after it withholds
 * `Content-Length`. A fully buffered Blob carries its own length, so seeking
 * works again — at the cost of holding the file in memory.
 * @param seekableEnd - end of the element's seekable range, 0 when none.
 * @param size - file size from the resource metadata, when known.
 * @param cap - buffering budget.
 * @returns `none` when seeking already works, `buffer` to fetch the whole file,
 *   or `blocked` when the file is too large for that.
 */
export function bufferingDecision(
  seekableEnd: number,
  size: number | undefined,
  cap: number = MAX_BUFFER_BYTES,
): 'none' | 'buffer' | 'blocked' {
  if (seekableEnd > 0) return 'none'
  if (size !== undefined && size > cap) return 'blocked'
  return 'buffer'
}
