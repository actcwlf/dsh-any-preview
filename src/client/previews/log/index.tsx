import { PreviewChrome } from '../../kernel/chrome.tsx'
/** Streaming log viewer: severity colouring, search, tail follow. */
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { ACTIVE_ROW, DOCUMENT_BODY, PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { followAfterScroll, isAtBottom } from './follow.ts'
import { scrollToRow } from '../../kernel/scroll.ts'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { createLogConsumer, levelOf } from './parse.ts'
import type { LogLevel } from './parse.ts'

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-label)',
  info: 'var(--dsw-alias-state-business-primary)',
  debug: 'var(--dsw-alias-label-tertiary)',
  none: 'var(--dsw-alias-label-primary)',
}

export function LogBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
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
    return <div style={PANE_FILL}>{t('common.loading')}</div>
  }

  const setScroller = (element: HTMLDivElement | null): void => {
    scroller.current = element
    scrollportRef?.(element)
  }

  return (
    <PreviewChrome
      toolbar={compact => (
        <SearchBar
          compact={compact}
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
        </SearchBar>
        )}
        status={log.truncated ? t('common.truncated') : undefined}
      >
      <div
          ref={setScroller}
          onScroll={() => {
            const element = scroller.current
            if (element === null) return
            const next = followAfterScroll({
              follow,
              manualOff: false,
              atBottom: isAtBottom(element.scrollTop, element.scrollHeight, element.clientHeight),
            })
            if (next !== follow) setFollow(next)
          }}
          style={{ ...DOCUMENT_BODY, flex: '1 1 auto', overflow: 'auto' }}
        >
        <div style={{ fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.55 }}>
          {visible.map(({ line, index }) => (
            <div
              key={index}
              data-row-index={index}
              style={{
                display: 'flex',
                gap: 10,
                padding: '0 12px',
                whiteSpace: 'pre',
                background: index === found.activeRow ? ACTIVE_ROW : undefined,
              }}
            >
              <span style={gutterStyle}>{index + 1}</span>
              <span style={{ color: LEVEL_COLOR[levelOf(line)] }}>
                <Marked text={line === '' ? ' ' : line} pattern={found.pattern} emphasis={index === found.activeRow} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </PreviewChrome>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
} as const

const gutterStyle = {
  flex: '0 0 auto', width: 48, textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' as const,
}

/** What the client entry registers for this format. */
export const logPreview: PreviewModule = {
  id: 'dsh-any-preview/log',
  extensions: ['log'],
  load: 'text-pages',
  wrap: false,
  title: () => t('log.title'),
  Body: LogBody,
}
