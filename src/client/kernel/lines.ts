/**
 * Incremental line splitting, tolerant of CRLF and of a line split across a
 * chunk boundary.
 */

/** A sink that receives complete lines as they are assembled. */
export interface LineConsumer {
  /** Consume the next chunk. */
  push(chunk: string): void
  /** Flush the trailing line, if any. Idempotent. */
  finish(): void
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
