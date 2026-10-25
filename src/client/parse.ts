/** Minimal RFC 4180-style delimited parsing: quotes, escaped quotes, embedded newlines. */

export interface ParsedTable {
  readonly rows: readonly string[][]
  readonly truncated: boolean
}

/** Pick the delimiter with the most occurrences on the first line. */
export function detectDelimiter(text: string): string {
  const head = (text.slice(0, 8192).split(/\r?\n/u)[0]) ?? ''
  const candidates = [',', '\t', ';', '|'] as const
  let best: string = ','
  let bestCount = 0
  for (const candidate of candidates) {
    const count = head.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/**
 * Parse a delimited text prefix. The caller owns the row budget so a huge file
 * never materializes as one array.
 * @param text - accumulated text (may be a prefix while pages stream in).
 * @param delimiter - field separator.
 * @param maxRows - stop after this many rows.
 * @returns the rows plus whether the budget cut the input short.
 */
export function parseDelimited(text: string, delimiter: string, maxRows: number): ParsedTable {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let truncated = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"' && field.length === 0) {
      quoted = true
      index += 1
      continue
    }
    if (char === delimiter) {
      endField()
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      endRow()
      index += 1
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
      continue
    }
    field += char
    index += 1
  }

  if (!truncated && (field.length > 0 || row.length > 0)) endRow()

  return { rows, truncated }
}
