/** JSONL record search: one result per non-empty raw line. */
import { forEachMatch } from '../../kernel/search.ts'

/** Matching records kept for navigation; the total count is always complete. */
export const JSONL_MATCH_LIMIT = 5_000

/** One JSONL search result. */
export interface JsonlSearchResult {
  readonly pattern: RegExp
  /** Matching 0-based line indices for navigation, in file order. */
  readonly lines: readonly number[]
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
  let total = 0
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line] ?? ''
    if (raw.trim() === '') continue
    if (forEachMatch(raw, pattern, () => {}) === 0) continue
    total += 1
    if (matches.length < limit) matches.push(line)
  }
  return { pattern, lines: matches, total }
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
  if (options.signal.aborted) return { matches: 0, lines: [] }
  const result = matchJsonlLines(text.split(/\r?\n/u), pattern, options.lineLimit)
  options.onSlice(1, result.total, result.lines)
  return { matches: result.total, lines: result.lines }
}
