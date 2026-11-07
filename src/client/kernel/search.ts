/** Query compilation, match ranges and row selection shared by every preview. */

/** How the current query should be interpreted. */
export interface SearchOptions {
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
}

/** Neutral search state. */
export const DEFAULT_SEARCH: SearchOptions = { query: '', regex: false, caseSensitive: false }

/** One matched span within a text. */
export interface MatchRange {
  readonly start: number
  readonly end: number
}

/** One occurrence inside a row/cell pair, used by the CSV table search. */
export interface SearchOccurrence {
  readonly row: number
  readonly cell: number
  readonly start: number
  readonly end: number
}

/**
 * Escape a literal so it can be embedded in a RegExp.
 * @param value - literal text.
 * @returns the escaped pattern source.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile the query once per change.
 * @param options - query, regex mode and case sensitivity.
 * @returns the pattern, or undefined when the query is empty or invalid.
 */
export function compileSearch(options: SearchOptions): RegExp | undefined {
  const query = options.query.trim()
  if (query === '') return undefined
  const flags = options.caseSensitive ? 'gu' : 'giu'
  try {
    return new RegExp(options.regex ? query : escapeRegExp(query), flags)
  } catch {
    // An in-progress regex is a normal state while typing; treat it as no query.
    return undefined
  }
}

/**
 * Find every non-overlapping match in one text.
 * @param text - the searchable text.
 * @param pattern - compiled query (its `lastIndex` is managed here).
 * @param limit - maximum ranges to return for one text.
 * @returns the matched spans in order.
 */
export function matchRanges(text: string, pattern: RegExp, limit = 200): MatchRange[] {
  const ranges: MatchRange[] = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while (ranges.length < limit && (match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      // A zero-width match would loop forever; step past it.
      pattern.lastIndex += 1
      continue
    }
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/**
 * Visit every non-overlapping match in one text.
 * @param text - the cell text.
 * @param pattern - compiled query.
 * @param visit - called for each match; collecting a range is optional.
 * @returns the number of matches, including those after the visitor's cap.
 */
export function forEachMatch(
  text: string,
  pattern: RegExp,
  visit: (range: MatchRange) => void,
): number {
  const regex = pattern.global
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`)
  regex.lastIndex = 0
  let count = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1
      continue
    }
    count += 1
    visit({ start: match.index, end: match.index + match[0].length })
  }
  return count
}

/**
 * Whether one text matches, without collecting ranges.
 * @param text - the searchable text.
 * @param pattern - compiled query.
 * @returns true when the pattern occurs.
 */
export function hasMatch(text: string, pattern: RegExp): boolean {
  return matchRanges(text, pattern, 1).length > 0
}

/**
 * Indices of the texts that match.
 * @param texts - searchable text per row.
 * @param pattern - compiled query.
 * @returns the matching row indices in order.
 */
export function matchingIndices(texts: readonly string[], pattern: RegExp): number[] {
  const indices: number[] = []
  for (let index = 0; index < texts.length; index += 1) {
    if (hasMatch(texts[index]!, pattern)) indices.push(index)
  }
  return indices
}
