/** Turning CSV text into rows: the one thing the row source cannot know itself. */
import { LIMITS } from '../../../shared/limits.ts'
import { createRowParser } from '../../kernel/text-pipeline.ts'

/**
 * Parse a line-aligned slice of CSV text into rows.
 * @param text - whole lines, possibly with an open final line.
 * @param delimiter - field separator.
 * @returns the rows and whether a row passed the line cap.
 */
export function parseCsvSlice(text: string, delimiter: string): { rows: string[][], overlong: boolean } {
  const rows: string[][] = []
  const parser = createRowParser(delimiter, cells => { rows.push([...cells]) }, LIMITS.csvLineChars)
  parser.push(text)
  parser.finish()
  return { rows, overlong: parser.overlong }
}
