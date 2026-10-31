/**
 * Read a window of CSV rows using the sparse index.
 *
 * A window is the unit the table renders: a few thousand rows starting at an arbitrary
 * row number. With an anchor every N rows the scan starts at the nearest anchor instead of
 * the file start, which keeps a jump cheap even in a multi-hundred-megabyte file.
 *
 * Today the text is the accumulated document text; swapping `text` for a ranged read later
 * only changes who supplies the string, not this logic.
 */
import { createRowParser } from './text-pipeline.ts'
import type { CsvIndex } from './csv-index.ts'

/** Rows returned for one window, plus the row number they start at. */
export interface RowWindow {
  readonly startRow: number
  readonly rows: string[][]
  /** True when one row passed the line cap and parsing stopped there. */
  readonly overlong: boolean
}

/** Advance past `count` rows; `short` marks a text that ended first. */
interface Skip {
  readonly offset: number
  /** True when fewer than `count` rows remained, so `offset` is mid-row. */
  readonly short: boolean
}

/**
 * Advance a character offset past `count` rows, honouring quotes.
 * @param text - the text to walk.
 * @param offset - where to start.
 * @param count - rows to skip.
 * @returns the offset after the last complete row, and whether the text ran out.
 */
function skipRows(text: string, offset: number, count: number): Skip {
  let quoted = false
  let cursor = offset
  let seen = 0
  for (let index = offset; index < text.length && seen < count; index += 1) {
    const char = text[index] ?? ''
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { index += 1; continue }
      quoted = !quoted
      continue
    }
    if (char === '\n' && !quoted) {
      seen += 1
      cursor = index + 1
    }
  }
  return { offset: cursor, short: seen < count }
}

/**
 * Read `count` rows starting at `fromRow`.
 * @param text - accumulated document text.
 * @param index - sparse index over the same text.
 * @param fromRow - zero-based first row.
 * @param count - rows to return.
 * @param delimiter - field separator the preview sniffed.
 * @param maxLineChars - stop parsing past a line this long, as the row buffer does.
 * @returns the rows, clamped to what exists.
 */
export function readWindow(
  text: string,
  index: CsvIndex,
  fromRow: number,
  count: number,
  delimiter: string,
  maxLineChars = Number.POSITIVE_INFINITY,
): RowWindow {
  const anchor = index.anchorBefore(fromRow)
  const startOffset = anchor?.offset ?? 0
  const skipped = fromRow - (anchor?.row ?? 0)
  const head = skipped === 0 ? { offset: startOffset, short: false } : skipRows(text, startOffset, skipped)
  // A row the text never finished is not a row for the start of a window.
  const from = head.short ? text.length : head.offset
  const tail = skipRows(text, from, count)
  // The last row of a file without a final newline still exists; `skipRows` runs out
  // of text before it counts that row, and the parser's `finish` closes it.
  const to = tail.short ? text.length : tail.offset

  const rows: string[][] = []
  const parser = createRowParser(delimiter, cells => { rows.push([...cells]) }, maxLineChars)
  parser.push(text.slice(from, to))
  parser.finish()
  return { startRow: fromRow, rows, overlong: parser.overlong }
}
