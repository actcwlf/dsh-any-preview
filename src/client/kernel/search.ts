/** Substring search over preview rows, shared by every text-based format. */

/** Rows plus the original index each came from. */
export interface FilteredRows<T> {
  readonly rows: readonly T[]
  readonly indices: readonly number[]
}

/**
 * Case-fold a query once, so per-row comparison stays cheap.
 * @param query - raw user input.
 * @returns the normalized needle.
 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * Keep the rows whose text contains the query, remembering their positions.
 * An empty query keeps everything, so callers need no special case.
 * @param rows - source rows in display order.
 * @param query - raw user input.
 * @param textOf - the searchable text of one row.
 * @returns the surviving rows and their original indices.
 */
export function filterRows<T>(
  rows: readonly T[],
  query: string,
  textOf: (row: T) => string,
): FilteredRows<T> {
  const needle = normalizeQuery(query)
  if (needle === '') {
    return { rows, indices: rows.map((_row, index) => index) }
  }
  const keptRows: T[] = []
  const keptIndices: number[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (textOf(row).toLowerCase().includes(needle)) {
      keptRows.push(row)
      keptIndices.push(index)
    }
  }
  return { rows: keptRows, indices: keptIndices }
}
