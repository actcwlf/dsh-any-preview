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
  /**
   * Called after each slice with what the scan knows so far: a reader can jump to the
   * first hit immediately instead of waiting for the whole file.
   */
  readonly onSlice?: (fraction: number, matches: number, lines: readonly number[]) => void
  readonly signal?: AbortSignal
  /** How many match lines to keep, so the reader can jump to them. */
  readonly lineLimit?: number
}

/** Result of one scan. */
export interface ScanResult {
  readonly matches: number
  /**
   * Zero-based line of each collected match, in order, capped at `lineLimit`. Line 0 is
   * the header, so a preview's body row is `line - 1`.
   */
  readonly lines: readonly number[]
  /** True when the scan ran to the end; false when it was aborted. */
  readonly completed: boolean
}

/** Matches whose line is kept when the caller does not say. */
export const DEFAULT_LINE_LIMIT = 5_000

/** Wait for the next macrotask so rendering can happen between slices. */
function breathe(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** Locates the line of each match of one scan, up to a limit. */
export interface LineCounter {
  /**
   * Record the line of a match.
   * @param text - the text the match index belongs to (one slice, or the whole text).
   * @param index - character offset of the match inside `text`.
   */
  record(text: string, index: number): void
  /**
   * Start the next slice, whose first line has this number.
   * @param line - line of the slice's first line.
   */
  nextSlice(line: number): void
  /** Lines recorded so far, in order. */
  readonly lines: readonly number[]
}

/**
 * Build a line counter for one scan.
 *
 * Matches arrive in ascending order and newlines are counted once as the scan advances,
 * so the cost stays linear in the text even when every row matches; past the limit the
 * caller still counts matches, it just stops locating them.
 * @param limit - how many lines to keep.
 */
export function createLineCounter(limit = DEFAULT_LINE_LIMIT): LineCounter {
  const lines: number[] = []
  let line = 0
  let cursor = 0
  return {
    record(text: string, index: number): void {
      if (limit <= 0 || lines.length >= limit) return
      for (let next = text.indexOf('\n', cursor); next !== -1 && next < index; next = text.indexOf('\n', next + 1)) {
        line += 1
      }
      if (index > cursor) cursor = index
      lines.push(line)
    },
    nextSlice(base: number): void {
      line = base
      cursor = 0
    },
    get lines(): readonly number[] {
      return lines
    },
  }
}

/**
 * Count matches of `pattern` in `text` without blocking the page.
 * @param text - the whole document text.
 * @param pattern - compiled expression; must be global so `lastIndex` advances.
 * @param options - slice size, progress callback and abort signal.
 * @returns the match count, the lines of the first matches, and whether it finished.
 */
export async function scanText(text: string, pattern: RegExp, options: ScanOptions = {}): Promise<ScanResult> {
  const chunk = Math.max(1024, options.chunk ?? 256 * 1024)
  const counter = createLineCounter(options.lineLimit)
  let matches = 0
  let offset = 0

  while (offset < text.length) {
    if (options.signal?.aborted === true) return { matches, lines: counter.lines, completed: false }
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
      // The text is scanned whole, so the counter's cursor simply keeps advancing.
      counter.record(text, found.index)
      if (found[0].length === 0) pattern.lastIndex += 1
    }
    offset = end
    options.onProgress?.(end / text.length)
    options.onSlice?.(end / text.length, matches, counter.lines)
    await breathe()
  }

  return { matches, lines: counter.lines, completed: true }
}
