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
  background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent)',
  color: 'inherit',
  borderRadius: 2,
  padding: '0 1px',
} as const

/** The navigated match: solid and outlined so it reads first. Amber stays bright in
 * both themes, so the text on it has to stay dark: the ink token is theme-independent. */
const EMPHASIS_MARK = {
  background: 'var(--dsw-alias-state-warn-secondary)',
  color: 'var(--dsw-static-neutral-1000)',
  borderRadius: 2,
  padding: '0 1px',
  fontWeight: 600,
  boxShadow: '0 0 0 1px var(--dsw-alias-border-l4)',
} as const
