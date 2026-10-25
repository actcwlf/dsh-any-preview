/** Render text with its query matches marked, optionally emphasising the active row. */
import type { ReactNode } from 'react'
import { matchRanges } from './search.ts'

/**
 * Draw every match of `pattern` inside `text`.
 * @param props.text - the source text.
 * @param props.pattern - compiled query, or undefined for no query.
 * @param props.emphasis - the row the navigation points at, drawn louder.
 */
export function Marked({ text, pattern, emphasis = false }: {
  readonly text: string
  readonly pattern: RegExp | undefined
  readonly emphasis?: boolean
}) {
  if (pattern === undefined || text === '') return <>{text}</>
  const ranges = matchRanges(text, pattern)
  if (ranges.length === 0) return <>{text}</>
  const style = emphasis ? EMPHASIS_MARK : MARK
  const parts: ReactNode[] = []
  let cursor = 0
  for (const [index, range] of ranges.entries()) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(<mark key={index} style={style}>{text.slice(range.start, range.end)}</mark>)
    cursor = range.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

/** Every match: visible, but quiet enough to leave the text readable. */
const MARK = {
  background: 'rgba(255, 213, 0, 0.38)',
  color: 'inherit',
  borderRadius: 2,
  padding: '0 1px',
} as const

/** The navigated match: solid and outlined so it reads first. */
const EMPHASIS_MARK = {
  background: 'rgb(255, 196, 0)',
  color: '#1a1a1a',
  borderRadius: 2,
  padding: '0 1px',
  fontWeight: 600,
  boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)',
} as const
