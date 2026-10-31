/** Streaming CSV/TSV table with windowed rows and search, over the incremental pipeline. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { windowRange } from '../../kernel/window.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { ACTIVE_ROW, PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import { previewSourceOf } from '../../kernel/source.ts'
import { createRowBuffer } from '../../kernel/text-pipeline.ts'
import type { RowBuffer } from '../../kernel/text-pipeline.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { DELIMITER_LABEL, detectDelimiter } from './detect.ts'

/** Row budget: beyond this the view stops accumulating and says so. */
const MAX_ROWS = LIMITS.csvRows

/** Fixed row height the windowing math relies on. */
const ROW_HEIGHT = 22

/** Rows rendered above and below the viewport to cover fast scrolling. */
const OVERSCAN = 8

/** Viewport height before the first measurement. */
const FALLBACK_VIEWPORT = 480

/** Widen ragged rows so the grid lines up under the header. */
function normalize(rows: readonly (readonly string[])[]): {
  cells: readonly (readonly string[])[]
  columns: number
} {
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  return {
    cells: rows.map(row => (row.length === columns
      ? row
      : [...row, ...Array<string>(columns - row.length).fill('')])),
    columns,
  }
}

export function CsvBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
  const source = previewSourceOf(content)
  const text = source.kind === 'text' ? source.text : ''
  const eof = source.kind === 'text' ? source.eof : false

  const bufferRef = useRef<RowBuffer | null>(null)
  const delimiterRef = useRef<string>(',')
  const consumedRef = useRef(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT)
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)

  // Consume during render: parsing is a pure fold over the new suffix, and the
  // `consumed` cursor makes a repeated render (StrictMode) a no-op. Doing this
  // in an effect would show an empty first frame and break server rendering.
  if (source.kind === 'text' && bufferRef.current === null && text.length > 0) {
    delimiterRef.current = detectDelimiter(text)
    bufferRef.current = createRowBuffer(delimiterRef.current, MAX_ROWS, LIMITS.csvLineChars)
  }
  const buffer = bufferRef.current
  if (buffer !== null && source.kind === 'text') {
    if (text.length > consumedRef.current) {
      // Only the new suffix is parsed; the prefix is never revisited.
      buffer.push(text.slice(consumedRef.current))
      consumedRef.current = text.length
    }
    if (eof && !buffer.complete) buffer.finish()
  }

  const ready = buffer !== null
  const rowCount = buffer?.rows.length ?? 0

  // Normalizing the whole grid is O(rows); memoize it so a scroll tick only
  // re-renders the window slice.
  const view = useMemo(() => {
    if (buffer === null) return null
    const rows = buffer.rows
    const header = rows[0] ?? []
    const body = rows.slice(1)
    const { cells, columns } = normalize([header, ...body])
    return { header: cells[0] ?? [], body: cells.slice(1), columns }
  }, [buffer, rowCount])

  const texts = useMemo(
    () => (view === null ? [] : view.body.map(row => row.join(' '))),
    [view],
  )
  const found = useSearch(texts, options)

  const visibleIndices = useMemo(() => {
    if (view === null) return []
    if (!filter || found.pattern === undefined) return view.body.map((_row, index) => index)
    return found.matches
  }, [view, filter, found.pattern, found.matches])

  useEffect(() => {
    if (!ready) return
    const element = scrollerRef.current
    if (element === null) return
    const measure = (): void => { setViewportHeight(element.clientHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ready])

  // Filtering changes the row set under the same scroll offset.
  useEffect(() => {
    if (!filter) return
    const element = scrollerRef.current
    if (element === null) return
    element.scrollTop = 0
    setScrollTop(0)
  }, [filter, found.matches])

  // Reveal the navigated match by its position in the visible set.
  useEffect(() => {
    const row = found.activeRow
    const element = scrollerRef.current
    if (row === undefined || element === null) return
    const position = filter ? visibleIndices.indexOf(row) : row
    if (position < 0) return
    const top = Math.max(0, position * ROW_HEIGHT - element.clientHeight / 2)
    element.scrollTop = top
    setScrollTop(top)
  }, [found.activeRow, filter, visibleIndices])

  if (buffer === null || view === null) {
    const empty = source.kind === 'text' && eof && text.length === 0
    return (
      <div style={PANE_FILL}>
        {empty ? t('csv.empty') : t('common.loading')}
      </div>
    )
  }

    const total = visibleIndices.length
    const { first, last } = windowRange({
      scrollTop,
      viewportHeight,
      rowCount: total,
      rowHeight: ROW_HEIGHT,
      overscan: OVERSCAN,
    })
    const windowIndices = visibleIndices.slice(first, last)

  // Only a real condition is worth a label here: the row budget.
  const status = buffer.overlong
    ? t('csv.lineTooLong', { limit: LIMITS.csvLineChars.toLocaleString('en-US') })
    : buffer.truncated
    ? t('csv.truncated', { limit: MAX_ROWS.toLocaleString('en-US') })
    : ''

  return (
    <PreviewChrome
      title={(
        <span>
          {t('csv.summary', { rows: view.body.length.toLocaleString('en-US'), columns: view.columns })}
          {t('csv.delimiter', { name: t(DELIMITER_LABEL[delimiterRef.current] ?? 'csv.comma') })}
        </span>
      )}
      toolbar={compact => (
        <SearchBar
          compact={compact}
          options={options}
          onChange={setOptions}
          matches={found.matches.length}
          index={found.index}
          total={view.body.length}
          onPrev={found.prev}
          onNext={found.next}
          filter={filter}
          onFilter={setFilter}
        />
      )}
      status={status === '' ? undefined : status}
    >
      <div
        ref={(element) => {
          scrollerRef.current = element
          scrollportRef?.(element)
        }}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        style={{ flex: '1 1 auto', overflow: 'auto' }}
      >
        <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--dsw-font-family)', fontSize: 12, whiteSpace: 'nowrap' }}>
          <thead>
            <tr>
              <th style={cornerStyle} />
              {view.header.map((value, column) => (
                <th key={column} style={headerStyle}>{value || t('csv.column', { index: column + 1 })}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr style={{ height: first * ROW_HEIGHT }}>
                <td colSpan={view.columns + 1} style={spacerCell} />
              </tr>
            )}
            {windowIndices.map((rowIndex) => {
              const active = rowIndex === found.activeRow
              return (
                <tr
                  key={rowIndex}
                  data-row-index={rowIndex}
                  style={{ height: ROW_HEIGHT, background: active ? ACTIVE_ROW : undefined }}
                >
                  <td style={active ? { ...indexStyle, background: ACTIVE_ROW } : indexStyle}>{rowIndex + 1}</td>
                  {(view.body[rowIndex] ?? []).map((value, column) => (
                    <td key={column} style={cellStyle}>
                      <Marked text={value} pattern={found.pattern} emphasis={active} />
                    </td>
                  ))}
                </tr>
              )
            })}
            {last < total && (
              <tr style={{ height: (total - last) * ROW_HEIGHT }}>
                <td colSpan={view.columns + 1} style={spacerCell} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </PreviewChrome>
  )
}

const shared = {
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
} as const

const headerStyle = {
  ...shared,
  position: 'sticky' as const,
  top: 0,
  zIndex: 1,
  padding: '5px 12px',
  textAlign: 'left' as const,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}

const cornerStyle = { ...headerStyle, left: 0, zIndex: 2, width: 1 }

const spacerCell = { padding: 0, border: 'none' } as const

const indexStyle = {
  padding: '0 10px',
  lineHeight: `${String(ROW_HEIGHT - 2)}px`,
  textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  position: 'sticky' as const,
  left: 0,
  background: 'var(--dsw-alias-bg-base)',
  userSelect: 'none' as const,
}

const cellStyle = {
  padding: '0 12px',
  lineHeight: `${String(ROW_HEIGHT - 2)}px`,
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
}

/** What the client entry registers for this format. */
export const csvPreview: PreviewModule = {
  id: 'dsh-any-preview/csv',
  extensions: ['csv', 'tsv'],
  load: 'text-pages',
  wrap: false,
  title: () => t('csv.title'),
  Body: CsvBody,
}
