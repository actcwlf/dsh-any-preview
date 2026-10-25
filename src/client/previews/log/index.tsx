/** Streaming log viewer: severity colouring, search, tail follow. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { scrollToRow } from '../../kernel/scroll.ts'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { createLogConsumer, levelOf } from './parse.ts'
import type { LogLevel } from './parse.ts'

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'rgb(248, 81, 73)',
  warn: 'rgb(210, 153, 34)',
  info: 'rgb(56, 139, 253)',
  debug: 'var(--dsw-alias-label-tertiary)',
  none: 'var(--dsw-alias-label-primary)',
}

export function LogBody({ content, scrollportRef }: PreviewBodyProps) {
  const log = useStreamedText(content, () => createLogConsumer())
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement | null>(null)
  const lines = log?.lines ?? []
  const found = useSearch(lines, options)
  const lineCount = lines.length
  const complete = log?.complete ?? false

  const visible = useMemo(() => {
    if (!filter || found.pattern === undefined) return lines.map((line, index) => ({ line, index }))
    return found.matches.map(index => ({ line: lines[index]!, index }))
  }, [lines, lines.length, filter, found.pattern, found.matches])

  useEffect(() => {
    if (!follow || !complete || found.pattern !== undefined) return
    const element = scroller.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [follow, complete, lineCount, found.pattern])

  useEffect(() => {
    if (found.activeRow === undefined) return
    scrollToRow(scroller.current, found.activeRow)
  }, [found.activeRow])

  if (log === null) {
    return <div style={emptyStyle}>正在读取…</div>
  }

  const setScroller = (element: HTMLDivElement | null): void => {
    scroller.current = element
    scrollportRef?.(element)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)' }}>
      <div style={barStyle}>
        <SearchBar
          options={options}
          onChange={setOptions}
          matches={found.matches.length}
          index={found.index}
          total={log.lines.length}
          onPrev={found.prev}
          onNext={found.next}
          filter={filter}
          onFilter={setFilter}
        >
          <label style={labelStyle}>
            <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />
            跟随尾部
          </label>
        </SearchBar>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {log.truncated ? '已截断' : ''}
        </span>
      </div>
      <div ref={setScroller} style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', fontSize: 12, lineHeight: 1.55 }}>
          {visible.map(({ line, index }) => (
            <div key={index} data-row-index={index} style={{ display: 'flex', gap: 10, padding: '0 12px', whiteSpace: 'pre' }}>
              <span style={gutterStyle}>{index + 1}</span>
              <span style={{ color: LEVEL_COLOR[levelOf(line)] }}>
                <Marked text={line === '' ? ' ' : line} pattern={found.pattern} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
} as const

const gutterStyle = {
  flex: '0 0 auto', width: 48, textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' as const,
}

const emptyStyle = {
  height: '100%', display: 'grid', placeItems: 'center', fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

/** What the client entry registers for this format. */
export const logPreview: PreviewModule = {
  id: 'dsh-any-preview/log',
  extensions: ['log'],
  load: 'text-pages',
  wrap: false,
  title: () => '日志',
  Body: LogBody,
}
