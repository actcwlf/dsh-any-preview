/** Turn a line-aligned JSONL slice into one-cell rows for the file source. */
import { createLineConsumer } from '../../kernel/lines.ts'

/**
 * Split a JSONL slice into raw-line rows.
 * @param text - one line-aligned slice.
 * @returns rows with one raw line each.
 */
export function parseJsonlSlice(text: string): { rows: string[][], overlong: boolean } {
  const rows: string[][] = []
  const sink = createLineConsumer(line => { rows.push([line]) })
  sink.push(text)
  sink.finish()
  return { rows, overlong: false }
}
