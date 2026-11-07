/** Turn a line-aligned log slice into one-cell rows for the file source. */
import { createLineConsumer } from '../../kernel/lines.ts'

/**
 * Split a log slice into rows.
 * @param text - one line-aligned slice.
 * @returns rows with a single line cell each.
 */
export function parseLogSlice(text: string): { rows: string[][], overlong: boolean } {
  const rows: string[][] = []
  const sink = createLineConsumer(line => { rows.push([line]) })
  sink.push(text)
  sink.finish()
  return { rows, overlong: false }
}
