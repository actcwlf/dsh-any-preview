/** JSONL record search: one result per non-empty raw line. */
import { forEachMatch, SEARCH_PAGE_SIZE } from '../../kernel/search.ts'

/** Matching records kept for navigation; the total count is always complete. */
export const JSONL_MATCH_LIMIT = SEARCH_PAGE_SIZE

/** One JSONL search result. */
export interface JsonlSearchResult {
  readonly pattern: RegExp
  /** Matching 0-based line indices for navigation, in file order. */
  readonly lines: readonly number[]
  /** First matching line of each page after the first. */
  readonly pages: readonly number[]
  /** Total matching records. */
  readonly total: number
}

/**
 * Match raw record lines, skipping blank lines and counting each record once.
 * @param lines - raw lines.
 * @param pattern - compiled expression.
 * @param limit - records to keep for navigation.
 * @returns matching line indices and the complete count.
 */
export function matchJsonlLines(
  lines: readonly string[],
  pattern: RegExp,
  limit = JSONL_MATCH_LIMIT,
): JsonlSearchResult {
  const matches: number[] = []
  const pages: number[] = []
  let total = 0
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line] ?? ''
    if (raw.trim() === '') continue
    if (forEachMatch(raw, pattern, () => {}) === 0) continue
    if (total > 0 && total % limit === 0) pages.push(line)
    total += 1
    if (matches.length < limit) matches.push(line)
  }
  return { pattern, lines: matches, pages, total }
}

/**
 * Collect one page of matching records at or after `cursor`.
 * @param lines - raw lines.
 * @param pattern - compiled expression.
 * @param cursor - first line wanted (0-based).
 * @param limit - page size.
 * @returns matching line indices in file order.
 */
export function matchJsonlPage(
  lines: readonly string[],
  pattern: RegExp,
  cursor: number,
  limit: number,
): number[] {
  const page: number[] = []
  for (let line = cursor; line < lines.length && page.length < limit; line += 1) {
    const raw = lines[line] ?? ''
    if (raw.trim() === '') continue
    if (forEachMatch(raw, pattern, () => {}) === 0) continue
    page.push(line)
  }
  return page
}

/** What a JSONL text scan may report. */
export interface JsonlScanOptions {
  readonly signal: AbortSignal
  readonly lineLimit: number
  readonly onSlice: (progress: number, matches: number, lines: readonly number[]) => void
}

/** What one JSONL text scan produced. */
export interface JsonlScanResult {
  readonly matches: number
  readonly lines: readonly number[]
  readonly pages: readonly number[]
}

/** A scan function over a JSONL file or delivered text. */
export type JsonlScanRunner = (pattern: RegExp, options: JsonlScanOptions) => Promise<JsonlScanResult>

/**
 * Search a delivered JSONL text without a file source.
 * @param text - complete text.
 * @param pattern - compiled query.
 * @param options - progress/abort hooks.
 * @returns matching record lines and the complete count.
 */
export async function scanJsonlText(
  text: string,
  pattern: RegExp,
  options: JsonlScanOptions,
): Promise<JsonlScanResult> {
  if (options.signal.aborted) return { matches: 0, lines: [], pages: [] }
  const result = matchJsonlLines(text.split(/\r?\n/u), pattern, options.lineLimit)
  options.onSlice(1, result.total, result.lines)
  return { matches: result.total, lines: result.lines, pages: result.pages }
}

/**
 * Search one page of delivered JSONL text.
 * @param text - complete text.
 * @param pattern - compiled query.
 * @param cursor - first line wanted.
 * @param limit - page size.
 * @returns matching lines in file order.
 */
export async function scanJsonlTextPage(
  text: string,
  pattern: RegExp,
  cursor: number,
  limit: number,
): Promise<readonly number[]> {
  return matchJsonlPage(text.split(/\r?\n/u), pattern, cursor, limit)
}
