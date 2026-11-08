/** Line-oriented log search: one result per matching line. */
import { forEachMatch, SEARCH_PAGE_SIZE } from '../../kernel/search.ts'

/** Matching lines kept for navigation; the total count is always complete. */
export const LOG_MATCH_LIMIT = SEARCH_PAGE_SIZE

/** One log search result. */
export interface LogSearchResult {
  readonly pattern: RegExp
  /** First matching lines for navigation, in file order. */
  readonly lines: readonly number[]
  /** First matching line of each page after the first. */
  readonly pages: readonly number[]
  /** Total matching lines in the searched text. */
  readonly total: number
}

/** What a whole-text scan may report while it walks. */
export interface LogScanOptions {
  readonly signal: AbortSignal
  readonly lineLimit: number
  readonly onSlice: (progress: number, matches: number, lines: readonly number[]) => void
}

/** What one whole-text scan produced. */
export interface LogScanResult {
  readonly matches: number
  readonly lines: readonly number[]
  readonly pages: readonly number[]
}

/** No query. */
export const EMPTY_LOG_SEARCH: LogSearchResult = {
  pattern: /(?:)/gu,
  lines: [],
  pages: [],
  total: 0,
}

/**
 * Match whole lines without joining or splitting cells.
 * @param lines - line text.
 * @param pattern - compiled expression.
 * @param limit - matching lines to keep for navigation.
 * @returns matching lines and the complete count.
 */
export function matchLogLines(
  lines: readonly string[],
  pattern: RegExp,
  limit = LOG_MATCH_LIMIT,
): LogSearchResult {
  const matches: number[] = []
  const pages: number[] = []
  let total = 0
  for (let line = 0; line < lines.length; line += 1) {
    if (forEachMatch(lines[line] ?? '', pattern, () => {}) === 0) continue
    if (total > 0 && total % limit === 0) pages.push(line)
    total += 1
    if (matches.length < limit) matches.push(line)
  }
  return { pattern, lines: matches, pages, total }
}

/**
 * Collect one page of matching lines at or after `cursor`.
 * @param lines - line text.
 * @param pattern - compiled expression.
 * @param cursor - first line wanted (0-based).
 * @param limit - page size.
 * @returns matching lines in file order.
 */
export function matchLogPage(
  lines: readonly string[],
  pattern: RegExp,
  cursor: number,
  limit: number,
): number[] {
  const page: number[] = []
  for (let line = cursor; line < lines.length && page.length < limit; line += 1) {
    if (forEachMatch(lines[line] ?? '', pattern, () => {}) === 0) continue
    page.push(line)
  }
  return page
}

/**
 * Search delivered text without a file source.
 * @param text - complete text.
 * @param pattern - compiled query.
 * @param options - progress/abort hooks.
 * @returns matching lines and the complete count.
 */
export async function scanLogText(text: string, pattern: RegExp, options: LogScanOptions): Promise<LogScanResult> {
  if (options.signal.aborted) return { matches: 0, lines: [], pages: [] }
  const result = matchLogLines(text.split(/\r?\n/u), pattern, options.lineLimit)
  options.onSlice(1, result.total, result.lines)
  return { matches: result.total, lines: result.lines, pages: result.pages }
}

/**
 * Search one page of a delivered log text.
 * @param text - complete text.
 * @param pattern - compiled query.
 * @param cursor - first line wanted.
 * @param limit - page size.
 * @returns matching lines in file order.
 */
export async function scanLogTextPage(
  text: string,
  pattern: RegExp,
  cursor: number,
  limit: number,
): Promise<readonly number[]> {
  return matchLogPage(text.split(/\r?\n/u), pattern, cursor, limit)
}
