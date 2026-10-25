/**
 * Feed the owner's accumulated text to a stateful consumer exactly once per
 * chunk. Formats keep their own parse state, so a page arriving never re-parses
 * the prefix.
 */
import { useRef } from 'react'
import type { DocumentContent } from './types.ts'

/** A consumer that turns text chunks into its own model. */
export interface StreamConsumer {
  /** Consume the next new chunk. */
  push(chunk: string): void
  /** Flush any carried state; must be idempotent. */
  finish(): void
}

/**
 * Build the consumer once and feed it the suffix that arrived since the last
 * render. Runs during render (parsing is a pure fold), and restarts when the
 * accumulated text shrank — the owner reset it for a new file version.
 * @param content - owner content; only `text` mode is consumed.
 * @param factory - builds the consumer for one file.
 * @returns the consumer, or null before any text arrived.
 */
export function useStreamedText<T extends StreamConsumer>(
  content: DocumentContent,
  factory: () => T,
): T | null {
  const state = useRef<{ consumer: T, consumed: number } | null>(null)
  if (content.kind !== 'text') return null
  const { text, eof } = content
  if (state.current !== null && text.length < state.current.consumed) state.current = null
  if (state.current === null) {
    if (text.length === 0) return null
    state.current = { consumer: factory(), consumed: 0 }
  }
  const current = state.current
  if (text.length > current.consumed) {
    current.consumer.push(text.slice(current.consumed))
    current.consumed = text.length
  }
  if (eof) current.consumer.finish()
  return current.consumer
}
