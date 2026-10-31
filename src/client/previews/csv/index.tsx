/** Streaming CSV/TSV table with windowed rows and search, over the incremental pipeline. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { windowRange } from '../../kernel/window.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { ACTIVE_ROW, PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import { previewSourceOf } from '../../kernel/source.ts'
import { createRowBuffer } from '../../kernel/text-pipeline.ts'
import type { RowBuffer } from '../../kernel/text-pipeline.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { scanText } from '../../kernel/search-scan.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { createCsvIndex } from '../../kernel/csv-index.ts'
import type { CsvIndex } from '../../kernel/csv-index.ts'
import { scaledRowHeight, windowedBodyRows } from '../../kernel/csv-window-state.ts'
import type { BodyRow, WindowedBody } from '../../kernel/csv-window-state.ts'
import { useWindowedRows } from '../../kernel/useWindowedRows.ts'
import { DELIMITER_LABEL, detectDelimiter } from './detect.ts'

/** Rows the incremental buffer keeps before the windowed path takes over. */
const ROW_BUDGET = LIMITS.csvRows

/** Text longer than this is read as windows instead of from the parsed rows. */
const LARGE_TEXT_CHARS = 2 * 1024 * 1024

/** One index anchor every N rows, so a jump scans at most that many rows. */
const INDEX_STRIDE = 10_000

/** Rows per window, and the quiet time after a drag before that window is read. */
const WINDOW_ROWS = 5_000
const SETTLE_MS = 200

/** Fixed row height; only a table past the browser's scroll limit scales it down. */
const ROW_HEIGHT = 22

/** Browsers stop growing an element's scroll height near 2^24 px (about 762,000 rows). */
const SCROLL_LIMIT_PX = 16_777_216

/** Floor for the scaled row height, so the far end of a huge file stays visible. */
const MIN_ROW_HEIGHT = 6

/** Rows rendered above and below the viewport to cover fast scrolling. */
const OVERSCAN = 8

/** Viewport height before the first measurement. */
const FALLBACK_VIEWPORT = 480

const cancelStyle = {
  font: 'inherit', fontSize: 11, padding: '0 6px', height: 22, borderRadius: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

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

/**
 * The body of a table that holds every parsed row in memory: the viewport slice and
 * the filler come straight from the scroll geometry.
 * @param indices - body rows to show, in order (a filtered subset or every row).
 * @param rows - parsed body rows, indexed by body row number.
 * @param scrollTop - scroller offset in pixels.
 * @param viewportHeight - visible height in pixels.
 * @returns the same shape the windowed path produces.
 */
function plainBodyRows(
  indices: readonly number[],
  rows: readonly (readonly string[])[],
  scrollTop: number,
  viewportHeight: number,
): WindowedBody {
  const { first, last } = windowRange({
    scrollTop,
    viewportHeight,
    rowCount: indices.length,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
  })
  const painted: BodyRow[] = []
  for (let position = first; position < last; position += 1) {
    const rowIndex = indices[position] ?? 0
    painted.push({ index: rowIndex, cells: rows[rowIndex] ?? [] })
  }
  return {
    rows: painted,
    topPad: first * ROW_HEIGHT,
    bottomPad: (indices.length - last) * ROW_HEIGHT,
  }
}

export function CsvBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
  const source = previewSourceOf(content)
  const text = source.kind === 'text' ? source.text : ''
  const eof = source.kind === 'text' ? source.eof : false

  const bufferRef = useRef<RowBuffer | null>(null)
  const indexRef = useRef<CsvIndex | null>(null)
  const delimiterRef = useRef<string>(',')
  const consumedRef = useRef(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT)
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const [deep, setDeep] = useState<{ progress: number, matches: number } | undefined>(undefined)

  // Consume during render: parsing is a pure fold over the new suffix, and the
  // `consumed` cursor makes a repeated render (StrictMode) a no-op. Doing this
  // in an effect would show an empty first frame and break server rendering.
  if (source.kind === 'text' && bufferRef.current === null && text.length > 0) {
    delimiterRef.current = detectDelimiter(text)
    bufferRef.current = createRowBuffer(delimiterRef.current, ROW_BUDGET, LIMITS.csvLineChars)
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

  // The sparse index accumulates the same way: row boundaries (quote-aware) that let
  // a window be read from the nearest anchor instead of from the start of the file.
  if (source.kind === 'text' && text.length > 0) {
    if (indexRef.current === null) indexRef.current = createCsvIndex(INDEX_STRIDE)
    indexRef.current.push(text)
  }
  const index = indexRef.current

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

  // Windowing takes over once the delivered text is large, or the moment the row
  // budget would hide rows: from here on there is no row cap, only a window cache.
  const windowed = source.kind === 'text' && (text.length > LARGE_TEXT_CHARS || buffer?.truncated === true)

  // Rows in the file, header included. `index.rows` counts newlines, so a last line
  // without one is an extra row — the rule the parser's `finish` also applies.
  const openLastLine = text.length > 0 && !text.endsWith('\n')
  const indexedRows = (index?.rows ?? 0) + (eof && openLastLine ? 1 : 0)
  // Every delivered page is indexed synchronously, so this estimate is already the
  // exact count of what arrived; it would run ahead of `index.rows` only if indexing
  // moved to an idle pass. That is when the product rule "adopt the exact count only
  // after a drag longer than about three screens" is needed back.
  const estimatedRows = Math.max(buffer?.rows.length ?? 1, index?.estimateRows(text.length) ?? 1, 1)
  const totalRows = Math.max(indexedRows, estimatedRows)

  // Past the browser's scroll-height limit the rows shrink proportionally instead of
  // the table being cut: the scrollbar still spans every row of the file.
  const rowHeight = windowed
    ? scaledRowHeight(Math.max(0, totalRows - 1), ROW_HEIGHT, SCROLL_LIMIT_PX, MIN_ROW_HEIGHT)
    : ROW_HEIGHT

  // Hooks run unconditionally. With `index: null` the hook reads nothing and returns an
  // empty window, which the non-windowed path below never looks at.
  const win = useWindowedRows({
    text: windowed ? text : '',
    index: windowed ? index : null,
    delimiter: delimiterRef.current,
    scrollTop,
    viewportHeight,
    totalRows,
    rowHeight,
    windowSize: WINDOW_ROWS,
    settleMs: SETTLE_MS,
    maxLineChars: LIMITS.csvLineChars,
  })

  const visibleIndices = useMemo(() => {
    if (view === null || windowed) return []
    if (!filter || found.pattern === undefined) return view.body.map((_row, index) => index)
    return found.matches
  }, [view, filter, found.pattern, found.matches, windowed])

  // A stable ref: an inline one detaches and re-attaches every render, and the owner
  // writes its remembered scroll offset on every attach — which fights a window drag.
  const bindScroller = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element
    scrollportRef?.(element)
  }, [scrollportRef])

  useEffect(() => {
    if (!ready) return
    const element = scrollerRef.current
    if (element === null) return
    const measure = (): void => {
      setViewportHeight(element.clientHeight)
      // The owner restores its remembered offset while attaching the ref; adopting it
      // here keeps the first painted band on the rows the reader left behind.
      setScrollTop(element.scrollTop)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ready])

  // A window cannot hide rows — it never holds the whole file — so a windowed table
  // keeps the highlight and drops filtering rather than filtering only what it can see.
  useEffect(() => {
    if (windowed && filter) setFilter(false)
  }, [windowed, filter])

  // Filtering changes the row set under the same scroll offset.
  useEffect(() => {
    if (!filter) return
    const element = scrollerRef.current
    if (element === null) return
    element.scrollTop = 0
    setScrollTop(0)
  }, [filter, found.matches])

  // Reveal the navigated match by its position in the visible set. In a windowed table
  // search indices are already body rows, so the same arithmetic finds them.
  useEffect(() => {
    const row = found.activeRow
    const element = scrollerRef.current
    if (row === undefined || element === null) return
    const position = windowed ? row : (filter ? visibleIndices.indexOf(row) : row)
    if (position < 0) return
    const top = Math.max(0, position * rowHeight - element.clientHeight / 2)
    element.scrollTop = top
    setScrollTop(top)
  }, [found.activeRow, filter, visibleIndices, windowed, rowHeight])

  // A large file cannot be searched from the parsed rows alone: the row budget keeps
  // only its head. The full text is scanned in slices so the page stays responsive,
  // with progress and a cancel control because that scan can take a while. Declared
  // above the loading return so the hook order never depends on the first parse.
  useEffect(() => {
    const query = options.query.trim()
    if (query === '' || source.kind !== 'text' || text.length < LARGE_TEXT_CHARS) {
      setDeep(undefined)
      return
    }
    const controller = new AbortController()
    setDeep({ progress: 0, matches: 0 })
    const flags = options.caseSensitive ? 'gu' : 'giu'
    let pattern: RegExp
    try {
      pattern = options.regex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), flags)
    } catch {
      setDeep(undefined)
      return
    }
    void scanText(text, pattern, {
      signal: controller.signal,
      onProgress: progress => setDeep(current => ({ progress, matches: current?.matches ?? 0 })),
    }).then((result) => {
      if (!controller.signal.aborted) setDeep({ progress: 1, matches: result.matches })
    }).catch(() => { /* aborted */ })
    return () => { controller.abort() }
  }, [options.query, options.regex, options.caseSensitive, text.length, source.kind])

  if (buffer === null || view === null) {
    const empty = source.kind === 'text' && eof && text.length === 0
    return (
      <div style={PANE_FILL}>
        {empty ? t('csv.empty') : t('common.loading')}
      </div>
    )
  }

  const dataRows = windowed ? Math.max(0, totalRows - 1) : view.body.length
  // The row box follows the (possibly scaled) row height, so text stays inside its row.
  const lineBox = { lineHeight: `${Math.max(10, Math.round(rowHeight - 2))}px` } as const
  const indexCell = { ...indexStyle, ...lineBox }
  const bodyCell = { ...cellStyle, ...lineBox }

  // What to paint, in body-row coordinates. A `null` cell list is a row whose window
  // has not been read yet: it keeps its height and shows nothing.
  const body = windowed
    ? windowedBodyRows(
      win.rows,
      win.startRow,
      totalRows,
      // Always the viewport band: a window holds 5,000 rows, the table paints a screen.
      windowRange({ scrollTop, viewportHeight, rowCount: Math.max(0, totalRows - 1), rowHeight, overscan: OVERSCAN }),
      rowHeight,
      win.loading,
      view.columns,
    )
    : plainBodyRows(visibleIndices, view.body, scrollTop, viewportHeight)
  const shown = body.rows
  const topPad = body.topPad
  const bottomPad = body.bottomPad

  // Aborting drops the progress line; the rows already highlighted stay.
  const cancelScan = (): void => { setDeep(undefined) }

  // Only a real condition is worth a label here: a line past the cap, or a row budget
  // that hid rows. A truncated buffer always switches the table to windows, so the
  // budget line stays as the guard for a caller that never reaches the windowed path.
  const status = deep !== undefined
    ? (deep.progress >= 1
        ? t('csv.scanDone', { count: deep.matches.toLocaleString('en-US') })
        : t('csv.scanProgress', { percent: Math.round(deep.progress * 100), count: deep.matches.toLocaleString('en-US') }))
    : buffer.overlong || win.overlong
    ? t('csv.lineTooLong', { limit: LIMITS.csvLineChars.toLocaleString('en-US') })
    : buffer.truncated && !windowed
    ? t('csv.truncated', { limit: ROW_BUDGET.toLocaleString('en-US') })
    : ''

  return (
    <PreviewChrome
      title={(
        <span>
          {t('csv.summary', { rows: dataRows.toLocaleString('en-US'), columns: view.columns })}
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
          total={dataRows}
          onPrev={found.prev}
          onNext={found.next}
          filter={filter}
          onFilter={setFilter}
          filterable={!windowed}
          children={deep === undefined || deep.progress >= 1 ? undefined : (<button type="button" onClick={cancelScan} style={cancelStyle}>{t('csv.cancelScan')}</button>)}
        />
      )}
      status={status === '' ? undefined : status}
    >
      <div
        ref={bindScroller}
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
            {topPad > 0 && (
              <tr style={{ height: topPad }}>
                <td colSpan={view.columns + 1} style={spacerCell} />
              </tr>
            )}
            {shown.map((row) => {
              if (row.cells === null) {
                return (
                  <tr key={row.index} style={{ height: rowHeight }}>
                    <td colSpan={view.columns + 1} style={spacerCell} />
                  </tr>
                )
              }
              const active = row.index === found.activeRow
              return (
                <tr
                  key={row.index}
                  data-row-index={row.index}
                  style={{ height: rowHeight, background: active ? ACTIVE_ROW : undefined }}
                >
                  <td style={active ? { ...indexCell, background: ACTIVE_ROW } : indexCell}>{row.index + 1}</td>
                  {row.cells.map((value, column) => (
                    <td key={column} style={bodyCell}>
                      <Marked text={value} pattern={found.pattern} emphasis={active} />
                    </td>
                  ))}
                </tr>
              )
            })}
            {bottomPad > 0 && (
              <tr style={{ height: bottomPad }}>
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
