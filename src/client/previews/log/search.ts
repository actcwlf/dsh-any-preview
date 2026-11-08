/** Line-oriented log search: one result per matching line. */
import { forEachMatch } from '../../kernel/search.ts'

/** Matching lines kept for navigation; the total count is always complete. */
export const LOG_MATCH_LIMIT = 5_000

/** One log search result. */
export interface LogSearchResult {
  readonly pattern: RegExp
  /** First matching lines for navigation, in file order. */
  readonly lines: readonly number[]
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
}

/** No query. */
export const EMPTY_LOG_SEARCH: LogSearchResult = {
  pattern: /(?:)/gu,
  lines: [],
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
  let total = 0
  for (let line = 0; line < lines.length; line += 1) {
    if (forEachMatch(lines[line] ?? '', pattern, () => {}) === 0) continue
    total += 1
    if (matches.length < limit) matches.push(line)
  }
  return { pattern, lines: matches, total }
}

/**
 * Search delivered text without a file source.
 * @param text - complete text.
 * @param pattern - compiled query.
 * @param options - progress/abort hooks.
 * @returns matching lines and the complete count.
 */
export async function scanLogText(text: string, pattern: RegExp, options: LogScanOptions): Promise<LogScanResult> {
  if (options.signal.aborted) return { matches: 0, lines: [] }
  const result = matchLogLines(text.split(/\r?\n/u), pattern, options.lineLimit)
  options.onSlice(1, result.total, result.lines)
  return { matches: result.total, lines: result.lines }
}
