/**
 * Sparse row index for a CSV text: remembers the character offset of every Nth row.
 *
 * With anchors, "jump to row 250,000" costs one forward scan from the nearest anchor
 * instead of a scan from the start, and the total row count can be estimated long before
 * the whole file is parsed. Quoting is honoured, so a newline inside quotes does not
 * create a phantom row.
 */

/** One row boundary, recorded every `stride` rows. */
export interface CsvAnchor {
  /** Zero-based row number of this anchor. */
  readonly row: number
  /** Character offset where that row starts. */
  readonly offset: number
}

/** Incremental indexer; feed it the text as it arrives. */
export interface CsvIndex {
  /** Consume more text; only the new suffix is scanned. */
  push(text: string): void
  /** Anchors recorded so far, in ascending row order. */
  readonly anchors: readonly CsvAnchor[]
  /** Rows counted so far (header included once the first newline is seen). */
  readonly rows: number
  /** Character offset scanned so far. */
  readonly scanned: number
  /** The anchor at or before `row`, or the first anchor. */
  anchorBefore(row: number): CsvAnchor | undefined
  /**
   * Estimate the total row count from the average rows-per-character so far.
   * @param totalChars - the file's character length, when known.
   */
  estimateRows(totalChars: number): number
}

/**
 * Build an indexer that records one anchor every `stride` rows.
 * @param stride - rows between anchors; larger means fewer anchors and longer jumps.
 */
export function createCsvIndex(stride = 10_000): CsvIndex {
  const anchors: CsvAnchor[] = [{ row: 0, offset: 0 }]
  let offset = 0
  let rows = 0
  let rowStart = 0
  let consumed = 0
  let quoted = false
  let pendingQuote = false

  return {
    push(text: string): void {
      if (text.length <= consumed) return
      for (let index = consumed; index < text.length; index += 1) {
        const char = text[index] ?? ''
        if (pendingQuote) {
          pendingQuote = false
          if (char === '"') { quoted = true; continue }
          quoted = false
        }
        if (quoted) {
          if (char === '"') {
            const next = text[index + 1]
            if (next === undefined) { pendingQuote = true; continue }
            if (next === '"') { index += 1; continue }
            quoted = false
          }
          continue
        }
        if (char === '"') { quoted = true; continue }
        if (char === '\n') {
          rows += 1
          rowStart = offset + 1
          if (rows % stride === 0) anchors.push({ row: rows, offset: rowStart })
        }
        offset += 1
      }
      consumed = text.length
    },
    get anchors(): readonly CsvAnchor[] { return anchors },
    get rows(): number { return rows },
    get scanned(): number { return offset },
    anchorBefore(row: number): CsvAnchor | undefined {
      let low = 0
      let high = anchors.length - 1
      let found: CsvAnchor | undefined = anchors[0]
      while (low <= high) {
        const middle = (low + high) >> 1
        const candidate = anchors[middle]
        if (candidate === undefined) break
        if (candidate.row <= row) { found = candidate; low = middle + 1 } else { high = middle - 1 }
      }
      return found
    },
    estimateRows(totalChars: number): number {
      if (offset === 0) return 0
      return Math.max(rows, Math.round((rows / offset) * totalChars))
    },
  }
}

/** Row starts inside one window, honouring quotes; offsets are absolute. */
export function rowOffsetsIn(text: string, fromRow: number, toRow: number, startOffset: number): number[] {
  const offsets: number[] = []
  let offset = startOffset
  let row = fromRow
  let quoted = false
  for (let index = 0; index < text.length && row < toRow; index += 1) {
    const char = text[index] ?? ''
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { index += 1; continue }
      quoted = !quoted
    }
    if (char === '\n' && !quoted) {
      row += 1
      if (row >= toRow) break
      offsets.push(offset + index + 1)
    }
  }
  return offsets
}
