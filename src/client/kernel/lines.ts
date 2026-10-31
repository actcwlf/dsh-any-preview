/**
 * Incremental line splitting, tolerant of CRLF and of a line split across a
 * chunk boundary, plus the counting helpers every row source needs.
 */

/** A sink that receives complete lines as they are assembled. */
export interface LineConsumer {
  /** Consume the next chunk. */
  push(chunk: string): void
  /** Flush the trailing line, if any. Idempotent. */
  finish(): void
}

/**
 * Count the newlines in `text`.
 * @param text - text to walk.
 * @param from - character to start at.
 */
export function countNewlines(text: string, from = 0): number {
  let rows = 0
  for (let index = text.indexOf('\n', from); index !== -1; index = text.indexOf('\n', index + 1)) rows += 1
  return rows
}

/**
 * Count the rows a slice holds.
 *
 * The last line of a file that does not end in a newline is still a row, so a slice that
 * reaches the end says so with `eof`.
 * @param text - slice text, whole lines except at end of file.
 * @param eof - whether the slice reached the end of the file.
 */
export function countRows(text: string, eof: boolean): number {
  return countNewlines(text) + (eof && text.length > 0 && !text.endsWith('\n') ? 1 : 0)
}

/**
 * Character offset just past the `rows`-th newline from `from`.
 * @param text - text to walk.
 * @param rows - lines to step over.
 * @param from - character to start at.
 * @returns the offset of the next line, or the end of the text.
 */
export function skipLines(text: string, rows: number, from = 0): number {
  let offset = from
  for (let step = 0; step < rows; step += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return text.length
    offset = next + 1
  }
  return offset
}

/**
 * Build a consumer that calls `onLine` once per complete line.
 * @param onLine - receives each line without its terminator.
 * @returns the consumer.
 */
export function createLineConsumer(onLine: (line: string) => void): LineConsumer {
  let carry = ''
  let done = false

  return {
    push(chunk: string): void {
      if (done || chunk.length === 0) return
      let text = carry + chunk
      let index = text.indexOf('\n')
      while (index >= 0) {
        let line = text.slice(0, index)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        onLine(line)
        text = text.slice(index + 1)
        index = text.indexOf('\n')
      }
      carry = text
    },
    finish(): void {
      if (done) return
      done = true
      if (carry.length > 0) {
        const line = carry.endsWith('\r') ? carry.slice(0, -1) : carry
        onLine(line)
        carry = ''
      }
    },
  }
}
