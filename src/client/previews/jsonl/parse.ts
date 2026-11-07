/** Line-delimited JSON: one record per line, bad lines kept as raw text. */
import { createLineConsumer } from '../../kernel/lines.ts'
import type { LineConsumer } from '../../kernel/lines.ts'
import type { StreamConsumer } from '../../kernel/stream.ts'

/** One input line's outcome. */
export interface JsonlRecord {
  /** 1-based line number in the source. */
  readonly line: number
  /** The line as received, always retained. */
  readonly raw: string
  /** Parsed value, absent when the line did not parse. */
  readonly value?: unknown
  /** Parse failure message, absent when the line parsed. */
  readonly error?: string
}

/** A streaming JSONL model. */
export interface JsonlConsumer extends StreamConsumer {
  readonly records: readonly JsonlRecord[]
  readonly invalid: number
  readonly truncated: boolean
  readonly complete: boolean
}

/**
 * Parse one source line into a record.
 * @param line - 1-based source line number.
 * @param raw - the line as received.
 * @returns the record, or undefined for a blank line.
 */
export function parseJsonlRecord(line: number, raw: string): JsonlRecord | undefined {
  if (raw.trim() === '') return undefined
  try {
    return { line, raw, value: JSON.parse(raw) as unknown }
  } catch (error) {
    return { line, raw, error: error instanceof Error ? error.message : 'invalid JSON' }
  }
}

/**
 * Build a consumer that parses one record per non-empty line.
 * @param maxRecords - record budget; past it the model reports truncation.
 * @returns the consumer.
 */
export function createJsonlConsumer(maxRecords = 20_000): JsonlConsumer {
  const records: JsonlRecord[] = []
  let invalid = 0
  let truncated = false
  let sourceLine = 0
  let complete = false

  const sink: LineConsumer = createLineConsumer((raw) => {
    // The source line number counts blanks too, so a reported line can be found
    // in the file.
    sourceLine += 1
    if (raw.trim() === '') return
    if (records.length >= maxRecords) {
      truncated = true
      return
    }
    const record = parseJsonlRecord(sourceLine, raw)
    if (record === undefined) return
    if (record.error !== undefined) invalid += 1
    records.push(record)
  })

  return {
    push: sink.push,
    finish(): void {
      sink.finish()
      complete = true
    },
    get records(): readonly JsonlRecord[] {
      return records
    },
    get invalid(): number {
      return invalid
    },
    get truncated(): boolean {
      return truncated
    },
    get complete(): boolean {
      return complete
    },
  }
}

/** Whether a parsed value is a plain object whose keys can become columns. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Collect the column names from the object records, in first-seen order.
 * @param records - parsed records.
 * @param limit - maximum columns to return.
 * @param scan - how many records to inspect.
 * @returns the column names.
 */
export function collectColumns(
  records: readonly JsonlRecord[],
  limit = 8,
  scan = 200,
): readonly string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const record of records.slice(0, scan)) {
    if (!isRecordObject(record.value)) continue
    for (const key of Object.keys(record.value)) {
      if (seen.has(key)) continue
      seen.add(key)
      columns.push(key)
      if (columns.length >= limit) return columns
    }
  }
  return columns
}

/**
 * Render one cell value for a table cell.
 * @param value - any parsed value.
 * @param max - maximum characters before truncation.
 * @returns the display text.
 */
export function formatValue(value: unknown, max = 80): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}
