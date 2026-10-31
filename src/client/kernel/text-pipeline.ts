/**
 * Incremental text parsing.
 *
 * The document owner delivers accumulated text — never one tidy whole file — so
 * re-parsing the prefix on every page would be quadratic. `createRowParser`
 * keeps its state across chunks and consumes each character exactly once;
 * `createRowBuffer` adds a row budget so a huge file neither grows memory nor
 * keeps burning CPU after the cap is reached.
 */

/** A stateful delimiter parser: feed chunks, then `finish` once at eof. */
export interface RowParser {
  /** Consume the next chunk of text. */
  push(chunk: string): void
  /** Flush the trailing field/row. Idempotent. */
  finish(): void
  /** True once a single line exceeded the cap; parsing stopped there. */
  readonly overlong: boolean
}

/**
 * Build a parser for one delimiter.
 * @param delimiter - field separator, one character.
 * @param onRow - receives each completed row.
 * @returns the parser.
 */
export function createRowParser(delimiter: string, onRow: (cells: readonly string[]) => void, maxLineChars = Number.POSITIVE_INFINITY): RowParser {
  let row: string[] = []
  let field = ''
  let quoted = false
  // A quote split across a chunk boundary is either an escape or a closer; the
  // next chunk decides, so the decision is deferred instead of guessed.
  let pendingQuote = false
  let done = false
  // A single unterminated line can be arbitrarily long (some exporters emit one line
  // per file). Stopping at a cap keeps the viewer from growing without bound.
  let lineChars = 0
  let overlong = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    onRow(row)
    row = []
  }

  return {
    push(chunk: string): void {
      if (done || chunk.length === 0) return
      let index = 0
      if (pendingQuote) {
        pendingQuote = false
        if (chunk.startsWith('"')) {
          field += '"'
          index = 1
        } else {
          quoted = false
        }
      }
      for (; index < chunk.length; index += 1) {
        if (lineChars > maxLineChars) {
          overlong = true
          done = true
          return
        }
        lineChars += 1
        const char = chunk[index]!
        if (quoted) {
          if (char !== '"') {
            field += char
            continue
          }
          const next = chunk[index + 1]
          if (next === undefined) {
            pendingQuote = true
            continue
          }
          if (next === '"') {
            field += '"'
            index += 1
            continue
          }
          quoted = false
          continue
        }
        if (char === '"' && field.length === 0) {
          quoted = true
          continue
        }
        if (char === delimiter) {
          endField()
          continue
        }
        if (char === '\r') continue
        if (char === '\n') {
          endRow()
          lineChars = 0
          continue
        }
        field += char
      }
    },
    get overlong(): boolean {
      return overlong
    },
    finish(): void {
      if (done) return
      done = true
      pendingQuote = false
      quoted = false
      if (field.length > 0 || row.length > 0) endRow()
    },
  }
}

/** A parser plus a row budget, so memory and CPU stay bounded on huge files. */
export interface RowBuffer {
  /** Consume the next chunk; ignored once the budget is exhausted. */
  push(chunk: string): void
  /** Flush the trailing row; marks the buffer complete. */
  finish(): void
  /** Rows parsed so far, header included. */
  readonly rows: readonly (readonly string[])[]
  /** Whether the input had more rows than the budget allowed. */
  readonly truncated: boolean
  /** Whether a single line exceeded the cap. */
  readonly overlong: boolean
  /** Whether `finish` ran. */
  readonly complete: boolean
}

/**
 * Build a bounded row buffer.
 * @param delimiter - field separator.
 * @param maxRows - row budget, header included.
 * @returns the buffer.
 */
export function createRowBuffer(delimiter: string, maxRows: number, maxLineChars = Number.POSITIVE_INFINITY): RowBuffer {
  const rows: string[][] = []
  let truncated = false
  let complete = false

  const parser = createRowParser(delimiter, cells => {
    if (rows.length >= maxRows) {
      truncated = true
      return
    }
    rows.push([...cells])
  }, maxLineChars)

  return {
    push(chunk: string): void {
      if (truncated || complete) return
      parser.push(chunk)
      if (parser.overlong) truncated = true
    },
    finish(): void {
      if (complete) return
      complete = true
      if (!truncated) parser.finish()
    },
    get rows(): readonly (readonly string[])[] {
      return rows
    },
    get truncated(): boolean {
      return truncated
    },
    get overlong(): boolean {
      return parser.overlong
    },
    get complete(): boolean {
      return complete
    },
  }
}
