/**
 * Row numbering for a table whose first file row is a header.
 *
 * File row 0 is the header, which the table draws once above its body, so body row `i`
 * is file row `i + 1`. Every conversion in the pipeline goes through here, so an
 * off-by-one has exactly one place to be wrong in.
 */

/**
 * File row of a body row.
 * @param bodyRow - zero-based body row.
 */
export function toFileRow(bodyRow: number): number {
  return bodyRow + 1
}

/**
 * Body row of a file row.
 * @param fileRow - zero-based file row, header included.
 * @returns the body row, or -1 for the header.
 */
export function toBodyRow(fileRow: number): number {
  return fileRow - 1
}

/**
 * Whether a file row is the header line.
 * @param fileRow - zero-based file row.
 */
export function isHeaderRow(fileRow: number): boolean {
  return fileRow <= 0
}
