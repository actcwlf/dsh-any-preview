/** Render text with its query matches marked. */
import type { ReactNode } from 'react'
import { matchRanges } from './search.ts'

/** Draw every match of `pattern` inside `text`. */
export function Marked({ text, pattern }: { readonly text: string; readonly pattern: RegExp | undefined }) {
  if (pattern === undefined || text === '') return <>{text}</>
  const ranges = matchRanges(text, pattern)
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  for (const [index, range] of ranges.entries()) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(<mark key={index} style={markStyle}>{text.slice(range.start, range.end)}</mark>)
    cursor = range.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

const markStyle = {
  background: 'rgba(255, 213, 0, 0.38)',
  color: 'inherit',
  borderRadius: 2,
  padding: '0 1px',
} as const
