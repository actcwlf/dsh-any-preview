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
}

/** Advance a character offset past `count` rows, honouring quotes. */
function skipRows(text: string, offset: number, count: number): number {
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
  return cursor
}

/**
 * Read `count` rows starting at `fromRow`.
 * @param text - accumulated document text.
 * @param index - sparse index over the same text.
 * @param fromRow - zero-based first row.
 * @param count - rows to return.
 * @returns the rows, clamped to what exists.
 */
/**
 * Same as {@link readRowWindow} but with an explicit delimiter, which is what the preview
 * uses after it has sniffed the file.
 */
export function readWindow(text: string, index: CsvIndex, fromRow: number, count: number, delimiter: string): RowWindow {
  const anchor = index.anchorBefore(fromRow)
  const startOffset = anchor?.offset ?? 0
  const skipped = fromRow - (anchor?.row ?? 0)
  const from = skipped === 0 ? startOffset : skipRows(text, startOffset, skipped)
  const to = skipRows(text, from, count)
  const slice = text.slice(from, to)

  const rows: string[][] = []
  const parser = createRowParser(delimiter, cells => { rows.push([...cells]) })
  parser.push(slice)
  parser.finish()
  return { startRow: fromRow, rows }
}
