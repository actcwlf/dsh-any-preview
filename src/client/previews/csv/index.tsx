/** Streaming CSV/TSV table with windowed rows and search, over the incremental pipeline. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { windowRange } from '../../kernel/window.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { useEffect, useMemo, useState } from 'react'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { ACTIVE_ROW, PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { bandRows, fitColumns, stickyBand, windowedBodyRows } from '../../kernel/window-state.ts'
import type { BodyRow, WindowedBody } from '../../kernel/window-state.ts'
import { useWindowedRows } from '../../kernel/useWindowedRows.ts'
import { DELIMITER_LABEL } from './detect.ts'
import { useCsvSource } from './source.ts'
import type { CsvView } from './source.ts'
import { useRowScroll } from './scroll.ts'
import { useWholeFileScan } from './scan.ts'
import type { ScanNavigation } from './scan.ts'
import { CsvTable } from './table.tsx'
import { OVERSCAN, ROW_HEIGHT, SCROLL_LIMIT_PX, SETTLE_MS, WINDOW_ROWS } from './layout.ts'

const cancelStyle = {
  font: 'inherit', fontSize: 11, padding: '0 6px', height: 22, borderRadius: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
  border: '0.5px solid var(--dsw-alias-border-l2)',
} as const

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

export function CsvBody(props: PreviewBodyProps) {
  useLocale()
  const source = useCsvSource(props)
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const { view, windowed } = source

  const texts = useMemo(
    () => (view === null ? [] : view.body.map(row => row.join(' '))),
    [view],
  )
  const found = useSearch(texts, options)

  const scroll = useRowScroll({
    scrollportRef: props.scrollportRef,
    ready: view !== null,
    windowed,
    fileMode: source.fileMode,
    fileRows: source.fileRows,
    textRows: source.textRows,
    rowHeight: ROW_HEIGHT,
    scrollLimit: SCROLL_LIMIT_PX,
  })

  // Hits for the rows in memory come first; the whole-file scan takes over once it has
  // any, so an arrow click is useful before the file has been walked.
  const fallback: ScanNavigation = {
    activeRow: found.activeRow,
    index: found.index,
    count: found.matches.length,
    next: found.next,
    prev: found.prev,
  }
  const scan = useWholeFileScan({
    scan: source.scan,
    query: options.query,
    regex: options.regex,
    caseSensitive: options.caseSensitive,
    origin: () => scroll.currentRow,
    revision: source.textLength,
    sourceKey: source.sourceKey,
    fallback,
  })

  const win = useWindowedRows({
    read: source.read,
    revision: source.revision,
    source: source.sourceKey,
    enabled: windowed,
    scrollTop: scroll.scrollTop,
    viewportHeight: scroll.viewportHeight,
    totalRows: scroll.totalRows,
    rowHeight: scroll.mappingPitch,
    windowSize: WINDOW_ROWS,
    settleMs: SETTLE_MS,
  })

  // Rows to paint while the table is not windowed: a filtered subset or every row.
  const visibleIndices = useMemo(() => {
    if (view === null || windowed) return []
    if (!filter || found.pattern === undefined) return view.body.map((_row, index) => index)
    return found.matches
  }, [view, filter, found.pattern, found.matches, windowed])

  // A window cannot hide rows — it never holds the whole file — so a windowed table
  // keeps the highlight and drops filtering rather than filtering only what it can see.
  const filterable = !windowed
  useEffect(() => {
    if (windowed && filter) setFilter(false)
  }, [windowed, filter])

  // Filtering changes the row set under the same scroll offset.
  const { scrollTo } = scroll
  useEffect(() => {
    if (!filter) return
    scrollTo(0)
  }, [filter, found.matches, scrollTo])

  // Reveal the navigated row by its position in the visible set. A windowed table's
  // search indices are already body rows, so the same arithmetic finds them.
  const { activeRow } = scan
  const { reveal } = scroll
  useEffect(() => {
    if (activeRow === undefined) return
    const position = windowed ? activeRow : (filter ? visibleIndices.indexOf(activeRow) : activeRow)
    if (position < 0) return
    reveal(position)
  }, [activeRow, filter, visibleIndices, windowed, reveal])

  if (view === null) {
    const empty = props.content.kind === 'text' && props.content.eof && props.content.text.length === 0
    return (
      <div style={PANE_FILL}>
        {empty ? t('csv.empty') : t('common.loading')}
      </div>
    )
  }

  const dataRows = windowed ? Math.max(0, scroll.totalRows - 1) : view.body.length
  const band = scroll.geometry === undefined
    ? undefined
    : stickyBand(scroll.logical, Math.max(0, scroll.totalRows - 1), scroll.geometry.visibleRows, ROW_HEIGHT, OVERSCAN)
  const body = band === undefined
    ? windowed
      ? windowedBodyRows(
        win.rows,
        win.startRow,
        scroll.totalRows,
        // Always the viewport band: a window holds 5,000 rows, the table paints a screen.
        windowRange({
          scrollTop: scroll.scrollTop,
          viewportHeight: scroll.viewportHeight,
          rowCount: Math.max(0, scroll.totalRows - 1),
          rowHeight: ROW_HEIGHT,
          overscan: OVERSCAN,
        }),
        ROW_HEIGHT,
        win.loading,
        view.columns,
      )
      : plainBodyRows(visibleIndices, view.body, scroll.scrollTop, scroll.viewportHeight)
    : {
      rows: bandRows(win.rows, win.startRow, band.first, band.first + band.count, win.loading, view.columns),
      topPad: 0,
      bottomPad: 0,
    }
  // While a window is being read, rows the delivered text already holds fill in: the
  // open of a big file switches source under the same first screen, and an empty frame
  // there is a visible flicker for no reason.
  const painted: readonly BodyRow[] = windowed && win.loading
    ? body.rows.map(row => (row.cells === null && row.index < view.body.length
      ? { index: row.index, cells: fitColumns(view.body[row.index] ?? [], view.columns) }
      : row))
    : body.rows
  // A window read past the built index has real rows but estimated numbers.
  const estimated = windowed && !win.exact
  const shown: WindowedBody = { rows: painted, topPad: body.topPad, bottomPad: body.bottomPad }

  // Only a real condition is worth a label here: a line past the cap, the row budget of
  // the non-windowed path, or the background walk that will make the row count exact.
  // While a scan runs, the count is what it has found *so far*; it becomes the total only
  // when the scan reaches the end.
  const state = scan.state
  const status = state !== undefined
    ? (state.done
        ? (state.aborted
          ? t('csv.scanStopped', { count: state.matches.toLocaleString('en-US') })
          : state.rows.length > 0 && state.rows.length < state.matches
            ? t('csv.scanDoneCapped', {
              count: state.matches.toLocaleString('en-US'),
              shown: state.rows.length.toLocaleString('en-US'),
            })
            : t('csv.scanDone', { count: state.matches.toLocaleString('en-US') }))
        : t('csv.scanProgress', { percent: Math.round(state.progress * 100), count: state.matches.toLocaleString('en-US') }))
    : source.overlong || win.overlong
    ? t('csv.lineTooLong', { limit: LIMITS.csvLineChars.toLocaleString('en-US') })
    : source.fileMode && !source.fileComplete
    ? t('csv.indexProgress', { percent: Math.round(source.fileProgress * 100) })
    : source.truncated && !windowed
    ? t('csv.truncated', { limit: LIMITS.csvRows.toLocaleString('en-US') })
    : ''

  return (
    <PreviewChrome
      title={(
        <span>
          {t('csv.summary', { rows: dataRows.toLocaleString('en-US'), columns: view.columns })}
          {t('csv.delimiter', { name: t(DELIMITER_LABEL[source.delimiter] ?? 'csv.comma') })}
        </span>
      )}
      toolbar={compact => (
        <SearchBar
          compact={compact}
          options={options}
          onChange={setOptions}
          matches={scan.count}
          index={scan.index}
          total={dataRows}
          onPrev={scan.prev}
          onNext={scan.next}
          onSubmit={scan.commit}
          filter={filter}
          onFilter={setFilter}
          filterable={filterable}
        >
          {state !== undefined && !state.done
            ? (<button type="button" onClick={scan.stop} style={cancelStyle}>{t('csv.cancelScan')}</button>)
            : (!compact && windowed && options.query.trim() !== ''
              ? (<button type="button" title={t('csv.scanFile')} onClick={scan.start} style={cancelStyle}>{t('csv.scanFile')}</button>)
              : undefined)}
        </SearchBar>
      )}
      status={status === '' ? undefined : status}
    >
      <CsvTable
        bindScroller={scroll.bindScroller}
        onScroll={scroll.setScrollTop}
        geometry={scroll.geometry}
        viewportHeight={scroll.viewportHeight}
        header={view.header}
        columns={view.columns}
        body={shown}
        bandOffset={band?.offset}
        activeRow={activeRow}
        pattern={found.pattern}
        estimated={estimated}
        rowHeight={ROW_HEIGHT}
      />
    </PreviewChrome>
  )
}

export const csvPreview: PreviewModule = {
  id: 'dsh-any-preview/csv',
  extensions: ['csv', 'tsv'],
  load: 'text-pages',
  wrap: false,
  title: () => t('csv.title'),
  Body: CsvBody,
}


