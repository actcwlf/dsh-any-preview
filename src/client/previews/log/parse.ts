/** Log line collection and severity spotting, streamed as lines arrive. */
import { createLineConsumer } from '../../kernel/lines.ts'
import type { LineConsumer } from '../../kernel/lines.ts'
import type { StreamConsumer } from '../../kernel/stream.ts'

/** A streaming log model. */
export interface LogConsumer extends StreamConsumer {
  readonly lines: readonly string[]
  readonly truncated: boolean
  readonly complete: boolean
}

/** Severity a line appears to carry. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'none'

const LEVELS: readonly [LogLevel, RegExp][] = [
  ['error', /\b(error|fatal|critical|panic|exception)\b/iu],
  ['warn', /\b(warn|warning)\b/iu],
  ['info', /\b(info|notice)\b/iu],
  ['debug', /\b(debug|trace|verbose)\b/iu],
]

/**
 * Guess a line's severity from its text. Deliberately loose: a preview only
 * needs to make the loud lines easy to find.
 * @param line - one log line.
 * @returns the first matching level, or `none`.
 */
export function levelOf(line: string): LogLevel {
  for (const [level, pattern] of LEVELS) {
    if (pattern.test(line)) return level
  }
  return 'none'
}

/**
 * Build a consumer that keeps lines under a budget.
 * @param maxLines - line budget; past it the model reports truncation.
 * @returns the consumer.
 */
export function createLogConsumer(maxLines = 20_000): LogConsumer {
  const lines: string[] = []
  let truncated = false
  let complete = false

  const sink: LineConsumer = createLineConsumer((line) => {
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    lines.push(line)
  })

  return {
    push: sink.push,
    finish(): void {
      sink.finish()
      complete = true
    },
    get lines(): readonly string[] {
      return lines
    },
    get truncated(): boolean {
      return truncated
    },
    get complete(): boolean {
      return complete
    },
  }
}
