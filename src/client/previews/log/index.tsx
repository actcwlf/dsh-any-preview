/** Streaming log viewer: severity colouring, search, tail follow and a file-backed window. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useEffect, useMemo, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { ACTIVE_ROW } from '../../kernel/layout.ts'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { followAfterScroll, isAtBottom } from './follow.ts'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { useWindowedRows } from '../../kernel/useWindowedRows.ts'
import { stickyBand } from '../../kernel/window-state.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { levelOf } from './parse.ts'
import type { LogLevel } from './parse.ts'
import { useLogSource } from './source.ts'
import { useLogScan } from './scan.ts'
import { LOG_OVERSCAN, LOG_ROW_HEIGHT, useLogScroll } from './scroll.ts'

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-label)',
  info: 'var(--dsw-alias-state-business-primary)',
  debug: 'var(--dsw-alias-label-tertiary)',
  none: 'var(--dsw-alias-label-primary)',
}

export function LogBody(props: PreviewBodyProps) {
  useLocale()
  const source = useLogSource(props)
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const [follow, setFollow] = useState(true)
  const scroll = useLogScroll({
    scrollportRef: props.scrollportRef,
    ready: source.windowed || source.totalRows > 0,
    totalRows: source.totalRows,
  })
  const win = useWindowedRows({
    read: source.read,
    revision: source.revision,
    source: source.sourceKey,
    enabled: source.windowed,
    scrollTop: scroll.scrollTop,
    viewportHeight: scroll.viewportHeight,
    totalRows: source.totalRows,
    rowHeight: scroll.mappingPitch,
    windowSize: 5_000,
    settleMs: 200,
  })
  const windowLines = win.rows.map(row => row[0] ?? '')
  const lines = source.windowed ? windowLines : source.lines
  const found = useSearch(lines, options)
  const scan = useLogScan({
    scan: source.scan,
    loadPage: source.page,
    query: options.query,
    regex: options.regex,
    caseSensitive: options.caseSensitive,
  })
  const baseRow = source.windowed ? win.startRow : 0
  const localActive = found.activeRow === undefined ? undefined : baseRow + found.activeRow
  const activeRow = scan.activeLine ?? localActive
  const scanning = scan.state !== undefined && !scan.state.done
  const searched = scan.state !== undefined
  const fullSearch = source.windowed
    ? scan.state === undefined
      ? 'idle'
      : scan.state.done
        ? scan.state.aborted ? 'stopped' : 'done'
        : 'scanning'
    : 'complete'

  const visible = useMemo(() => {
    if (!filter || found.pattern === undefined) {
      return lines.map((line, index) => ({ line, index }))
    }
    return found.matches.map(index => ({ line: lines[index]!, index }))
  }, [lines, lines.length, filter, found.pattern, found.matches])

  useEffect(() => {
    if (!follow || found.pattern !== undefined) return
    scroll.scrollToBottom()
  }, [follow, source.windowed, source.totalRows, source.complete, found.pattern, scroll.scrollToBottom])

  useEffect(() => {
    if (activeRow === undefined) return
    scroll.reveal(activeRow)
  }, [activeRow, scroll.reveal])

  if (!source.windowed && source.lines.length === 0) {
    return <PreviewState kind="LOG" title={t('log.title')} message={t('common.loading')} />
  }

  const renderRow = (index: number, line: string) => (
    <div
      key={index}
      data-row-index={index}
      style={{
        display: 'flex',
        gap: 10,
        height: LOG_ROW_HEIGHT,
        padding: '0 12px',
        whiteSpace: 'pre',
        background: index === activeRow ? ACTIVE_ROW : undefined,
      }}
    >
      <span style={gutterStyle}>{index + 1}</span>
      <span style={{ color: LEVEL_COLOR[levelOf(line)] }}>
        <Marked text={line === '' ? ' ' : line} pattern={found.pattern} emphasis={index === activeRow} />
      </span>
    </div>
  )

  const pinned = source.windowed && scroll.geometry !== undefined
  const band = pinned
    ? stickyBand(scroll.logical, source.totalRows, scroll.geometry.visibleRows, LOG_ROW_HEIGHT, LOG_OVERSCAN)
    : undefined
  const contentHeight = pinned ? scroll.contentHeight : source.windowed ? source.totalRows * LOG_ROW_HEIGHT : undefined
  const status = source.windowed
    ? scan.state?.done === true && scan.state.aborted
      ? t('log.scanStopped', { count: scan.count.toLocaleString('en-US') })
      : scan.loadingPage
        ? t('log.pageLoading')
        : source.complete ? undefined : t('log.indexing', { percent: String(Math.round(source.progress * 100)) })
    : source.truncated ? t('common.truncated') : undefined

  return (
    <PreviewChrome
      kind="LOG"
      title={t('log.summary', { count: source.totalRows.toLocaleString('en-US') })}
      toolbar={compact => (
        <SearchBar
          compact={compact}
          options={options}
          onChange={setOptions}
          matches={searched ? scan.count : found.matches.length}
          index={searched ? scan.index : found.index}
          total={source.totalRows}
          onPrev={searched ? scan.prev : found.prev}
          onNext={searched ? scan.next : found.next}
          onSubmit={source.windowed
            ? () => {
              if (scan.state?.done === true) {
                if (scan.state.aborted) scan.start()
                else if (scan.count > 0) scan.next()
              } else if (!scanning) {
                scan.start()
              }
            }
            : undefined}
          onCancel={source.windowed ? scan.stop : undefined}
          fullSearch={fullSearch}
          scanProgress={scan.state?.progress ?? 0}
          filter={filter}
          onFilter={setFilter}
          filterable={!source.windowed}
          placeholder={source.windowed ? t('log.searchFull') : undefined}
        />
      )}
      status={status}
      tone={status === undefined ? 'normal' : 'warning'}
    >
      <div
        ref={scroll.bindScroller}
        data-log-scroller="true"
        onScroll={event => {
          const element = event.currentTarget
          scroll.setScrollTop(element.scrollTop)
          const next = followAfterScroll({
            follow,
            manualOff: false,
            atBottom: isAtBottom(element.scrollTop, element.scrollHeight, element.clientHeight),
          })
          if (next !== follow) setFollow(next)
        }}
        style={{ flex: '1 1 auto', overflow: 'auto', overflowAnchor: 'none' }}
      >
        {source.windowed ? (
          <div style={{ height: contentHeight, position: 'relative' }}>
            <div
              style={pinned
                ? { ...pinnedBlock, height: scroll.viewportHeight }
                : codeStyle}
            >
              <div style={pinned && band !== undefined ? { transform: `translateY(${String(-band.offset)}px)` } : undefined}>
                {pinned && band !== undefined ? (
                  Array.from({ length: band.count }, (_value, offset) => {
                    const index = band.first + offset
                    const row = win.rows[index - win.startRow]
                    return renderRow(index, row?.[0] ?? '')
                  })
                ) : (
                  <>
                    {win.startRow > 0 && <div style={{ height: win.startRow * LOG_ROW_HEIGHT }} />}
                    {win.rows.map((row, offset) => renderRow(win.startRow + offset, row[0] ?? ''))}
                    {source.totalRows - win.startRow - win.rows.length > 0 && (
                      <div style={{ height: (source.totalRows - win.startRow - win.rows.length) * LOG_ROW_HEIGHT }} />
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div style={codeStyle}>
            {visible.map(({ line, index }) => renderRow(index, line))}
          </div>
        )}
      </div>
    </PreviewChrome>
  )
}

const codeStyle = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 12,
  lineHeight: `${String(LOG_ROW_HEIGHT)}px`,
} as const

const gutterStyle = {
  flex: '0 0 auto', width: 48, textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' as const,
} as const

const pinnedBlock = {
  position: 'sticky' as const,
  top: 0,
  overflow: 'hidden',
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 12,
  lineHeight: `${String(LOG_ROW_HEIGHT)}px`,
} as const

/** What the client entry registers for this format. */
export const logPreview: PreviewModule = {
  id: 'dsh-any-preview/log',
  extensions: ['log'],
  load: 'text-pages',
  wrap: false,
  title: () => t('log.title'),
  Body: LogBody,
}
