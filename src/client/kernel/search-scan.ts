/**
 * Streaming search over a large text, with progress and cancellation.
 *
 * The row-based search in `useSearch` only sees the rows a preview has loaded; on a big
 * file that is a small prefix. This scan walks the whole text in slices, yielding to the
 * event loop between them, so the UI can show progress and let the user stop.
 */

/** How the scan slices the text. */
export interface ScanOptions {
  /** Characters per slice; smaller keeps the UI responsive, larger finishes sooner. */
  readonly chunk?: number
  /** Called with 0..1 after each slice. */
  readonly onProgress?: (fraction: number) => void
  readonly signal?: AbortSignal
}

/** Result of one scan. */
export interface ScanResult {
  readonly matches: number
  /** True when the scan ran to the end; false when it was aborted. */
  readonly completed: boolean
}

/** Wait for the next macrotask so rendering can happen between slices. */
function breathe(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/**
 * Count matches of `pattern` in `text` without blocking the page.
 * @param text - the whole document text.
 * @param pattern - compiled expression; must be global so `lastIndex` advances.
 * @param options - slice size, progress callback and abort signal.
 * @returns the match count and whether the scan finished.
 */
export async function scanText(text: string, pattern: RegExp, options: ScanOptions = {}): Promise<ScanResult> {
  const chunk = Math.max(1024, options.chunk ?? 256 * 1024)
  let matches = 0
  let offset = 0

  while (offset < text.length) {
    if (options.signal?.aborted === true) return { matches, completed: false }
    const end = Math.min(text.length, offset + chunk)
    // One expression over the whole text: `lastIndex` carries across slices, so a match
    // that straddles a boundary is counted once instead of being missed.
    pattern.lastIndex = offset
    for (;;) {
      const found = pattern.exec(text)
      if (found === null) break
      if (found.index >= end) {
        pattern.lastIndex = found.index
        break
      }
      matches += 1
      if (found[0].length === 0) pattern.lastIndex += 1
    }
    offset = end
    options.onProgress?.(end / text.length)
    await breathe()
  }

  return { matches, completed: true }
}
