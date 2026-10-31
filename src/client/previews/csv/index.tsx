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
import { bandRows, fitColumns, logicalRow, proportionalGeometry, stickyBand, windowedBodyRows } from '../../kernel/csv-window-state.ts'
import type { BodyRow, WindowedBody } from '../../kernel/csv-window-state.ts'
import { readWindow } from '../../kernel/csv-window.ts'
import { useWindowedRows } from '../../kernel/useWindowedRows.ts'
import type { WindowRead } from '../../kernel/useWindowedRows.ts'
import { openCsvFile, scanCsvFile } from '../../kernel/csv-file.ts'
import type { CsvFile } from '../../kernel/csv-file.ts'
import { fileSize } from '../../kernel/zip.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { DELIMITER_LABEL, detectDelimiter } from './detect.ts'

/** Rows the incremental buffer keeps before the windowed path takes over. */
const ROW_BUDGET = LIMITS.csvRows

/** Windowing takes over once the delivered text is large, or the row budget is hit. */
const LARGE_TEXT_CHARS = 2 * 1024 * 1024

/** A drag this many screens long may replace an estimated total with the exact one. */
const EXACT_SWITCH_SCREENS = 3

/** One index anchor every N rows, so a jump scans at most that many rows. */
const INDEX_STRIDE = 10_000

/** Rows per window, and the quiet time after a drag before that window is read. */
const WINDOW_ROWS = 5_000
const SETTLE_MS = 200

/** Fixed row height; the table never squeezes its rows. */
const ROW_HEIGHT = 22

/**
 * Browsers stop growing an element's scroll height near 2^24 px (about 727,000 rows at
 * 22px). Past that the scrollbar turns proportional instead of the rows shrinking.
 */
const SCROLL_LIMIT_PX = 16_777_216

/** Rows rendered above and below the viewport to cover fast scrolling. */
const OVERSCAN = 8

/** Viewport height before the first measurement. */
const FALLBACK_VIEWPORT = 480

const cancelStyle = {
  font: 'inherit', fontSize: 11, padding: '0 6px', height: 22, borderRadius: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

/** Where the file-backed source stands. `failed` means the text path keeps the table. */
type FileStatus = 'idle' | 'opening' | 'ready' | 'failed'

/** File source state the table renders from. */
interface FileState {
  readonly status: FileStatus
  /** Bumps when the index grows; drops cached windows. */
  readonly revision: number
  /** Best-known rows, header included. */
  readonly total: number
  /** Fraction of the file walked so far, 0..1. */
  readonly progress: number
  readonly complete: boolean
}

const IDLE_FILE: FileState = { status: 'idle', revision: 0, total: 0, progress: 0, complete: false }
const OPENING_FILE: FileState = { status: 'opening', revision: 0, total: 0, progress: 0, complete: false }
const FAILED_FILE: FileState = { status: 'failed', revision: 0, total: 0, progress: 0, complete: false }

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

export function CsvBody({ content, resourceAddress, scrollportRef, useResource }: PreviewBodyProps) {
  useLocale()
  const source = previewSourceOf(content)
  const text = source.kind === 'text' ? source.text : ''
  const eof = source.kind === 'text' ? source.eof : false
  // The file's Host path, when the owner reports one: it is what lets the table read
  // the file itself instead of waiting for page after page.
  const { absolutePath } = useDocument(content, resourceAddress, useResource)

  const bufferRef = useRef<RowBuffer | null>(null)
  const indexRef = useRef<CsvIndex | null>(null)
  const delimiterRef = useRef<string>(',')
  const consumedRef = useRef(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<CsvFile | null>(null)
  const openedRef = useRef<string | null>(null)
  const adoptRef = useRef({ shown: 0, at: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT)
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const [deep, setDeep] = useState<{ progress: number, matches: number } | undefined>(undefined)
  // A file the owner has not finished handing over may be a big one, and a big one's row
  // pitch is compressed. Start on the loading line for it instead of painting the natural
  // pitch for a frame and then squeezing it.
  const [fileState, setFileState] = useState<FileState>(() => (
    absolutePath !== undefined && source.kind === 'text' && !source.eof ? OPENING_FILE : IDLE_FILE
  ))

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

  // Windowing takes over once the delivered text is large, the moment the row budget
  // would hide rows, or as soon as the file itself is the source: from here on there
  // is no row cap, only a window cache.
  const textWindowed = source.kind === 'text' && (text.length > LARGE_TEXT_CHARS || buffer?.truncated === true)
  const fileMode = fileState.status === 'ready'
  const windowed = textWindowed || fileMode

  // Rows in the file, header included. `index.rows` counts newlines, so a last line
  // without one is an extra row — the rule the parser's `finish` also applies.
  const openLastLine = text.length > 0 && !text.endsWith('\n')
  const indexedRows = (index?.rows ?? 0) + (eof && openLastLine ? 1 : 0)
  // Every delivered page is indexed synchronously, so this estimate is already the
  // exact count of what arrived.
  const estimatedRows = Math.max(buffer?.rows.length ?? 1, index?.estimateRows(text.length) ?? 1, 1)
  const textTotalRows = Math.max(indexedRows, estimatedRows)

  // A file's row count starts as an estimate from the bytes read and becomes exact
  // when the background walk ends. The product rule is not to swap it in immediately:
  // the new total is adopted on the next drag longer than about three screens, so the
  // scrollbar never changes length under the reader's hand.
  let totalRows: number
  if (fileMode) {
    const hold = adoptRef.current
    if (hold.shown === 0 || Math.abs(scrollTop - hold.at) > EXACT_SWITCH_SCREENS * viewportHeight) {
      hold.shown = Math.max(1, fileState.total)
      hold.at = scrollTop
    }
    totalRows = Math.max(1, hold.shown)
  } else {
    totalRows = textTotalRows
    adoptRef.current.shown = 0
  }

  // A table taller than the browser's scroll limit keeps its natural row height and gets
  // a proportional scrollbar instead: the content is a fixed-height spacer and a scroll
  // position selects a row. Shrinking the rows to fit is what made 2,000,000 rows render
  // as 8px slivers — a table row is never shorter than its line box, so the scrollbar
  // stopped matching the row numbers entirely.
  const bodyRows = windowed ? Math.max(0, totalRows - 1) : 0
  const geometry = windowed && bodyRows * ROW_HEIGHT > SCROLL_LIMIT_PX
    ? proportionalGeometry(bodyRows, viewportHeight, ROW_HEIGHT, SCROLL_LIMIT_PX)
    : undefined
  // The hook plans windows from a scroll offset; in the proportional mode a pixel is
  // worth `pitch` rows rather than one row's height.
  const mappingPitch = geometry === undefined ? ROW_HEIGHT : geometry.pitch
  const logical = geometry === undefined ? 0 : logicalRow(scrollTop, geometry, bodyRows)

  // One window, from the file when there is one and from the delivered text otherwise.
  // The callback is read through a ref by the hook, so its identity does not matter.
  const readRows = useCallback(async (startRow: number, count: number): Promise<WindowRead> => {
    const file = fileRef.current
    if (fileMode && file !== null) {
      try {
        const read = await file.read(startRow, count)
        return { rows: read.rows, overlong: read.overlong, exact: read.exact }
      } catch (error) {
        // The file source broke mid-session (route gone, file changed): hand the table
        // back to the delivered text instead of leaving it on placeholders.
        setFileState(FAILED_FILE)
        throw error
      }
    }
    if (index === null) return { rows: [], overlong: false, exact: true }
    const read = readWindow(text, index, startRow, count, delimiterRef.current, LIMITS.csvLineChars)
    return { rows: read.rows, overlong: read.overlong, exact: true }
  }, [fileMode, index, text])

  // Hooks run unconditionally. With `enabled: false` the hook reads nothing and returns
  // an empty window, which the non-windowed path below never looks at.
  const win = useWindowedRows({
    read: readRows,
    // Cached windows hold rows, not counts: only a change of the rows or of their
    // numbering has to drop them. The background walk changes neither until it finishes,
    // so it must not clear the cache on every slice — that is what blanked the table
    // while indexing. Completion is the one moment the numbers become exact.
    revision: fileMode ? (fileState.complete ? 1 : 0) : text.length,
    source: fileMode ? 'file' : 'text',
    enabled: windowed,
    scrollTop,
    viewportHeight,
    totalRows,
    rowHeight: mappingPitch,
    windowSize: WINDOW_ROWS,
    settleMs: SETTLE_MS,
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

  // The document owner hands a file over 5,000 rows at a time and never seeks, so a
  // big file needs its own source: probe the size once, and only take the file path
  // for a file too big to page. Small files keep the instant text path.
  useEffect(() => {
    const path = absolutePath
    if (path === undefined || text.length === 0 || openedRef.current === path) return undefined
    openedRef.current = path
    const controller = new AbortController()
    let live = true
    setFileState(OPENING_FILE)
    void (async () => {
      try {
        const media = fileUrl(path)
        const bytes = media === undefined ? undefined : await fileSize(media)
        if (bytes === undefined || bytes <= LARGE_TEXT_CHARS) {
          if (live) setFileState(FAILED_FILE)
          return
        }
        const file = await openCsvFile(path, delimiterRef.current, controller.signal)
        if (!live) {
          file.dispose()
          return
        }
        fileRef.current = file
        setFileState({
          status: 'ready',
          revision: file.revision,
          total: file.totalRows(),
          progress: file.size > 0 ? file.scanned / file.size : 1,
          complete: file.complete,
        })
      } catch {
        // No route, no permission, or a path the Host will not serve: the delivered
        // text keeps the table working, so this is not an error the reader must see.
        if (live) setFileState(FAILED_FILE)
      }
    })()
    return () => {
      live = false
      controller.abort()
      fileRef.current?.dispose()
      fileRef.current = null
      // Let a re-run (StrictMode's second mount, or a new file) open again.
      openedRef.current = null
    }
  }, [absolutePath, text.length === 0])

  // Walk the rest of the file in the background so the scrollbar and the row numbers
  // can become exact. One slice per idle callback: the first screen never waits.
  useEffect(() => {
    if (fileState.status !== 'ready' || fileState.complete) return undefined
    let live = true
    const step = (): void => {
      const file = fileRef.current
      if (!live || file === null) return
      void file.advance().then((more) => {
        if (!live) return
        setFileState({
          status: 'ready',
          revision: file.revision,
          total: file.totalRows(),
          progress: file.size > 0 ? file.scanned / file.size : 1,
          complete: file.complete,
        })
        if (more) schedule()
      }, () => {
        // A half-indexed file still reads what it has; the text path takes over only
        // if the source could not be opened at all.
        if (live) setFileState(current => ({ ...current, complete: true }))
      })
    }
    const schedule = (): void => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(step, { timeout: 1000 })
      else setTimeout(step, 0)
    }
    schedule()
    return () => { live = false }
  }, [fileState.status, fileState.complete])

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
    const top = Math.max(0, position * mappingPitch - element.clientHeight / 2)
    element.scrollTop = top
    setScrollTop(top)
  }, [found.activeRow, filter, visibleIndices, windowed, mappingPitch])

  // A large file cannot be searched from the parsed rows alone: the row budget keeps
  // only its head. With a file source the whole file is scanned slice by slice; without
  // one, the delivered text is. Either way the page stays responsive, with progress and
  // a cancel control. Declared above the loading return so hook order never depends on
  // the first parse.
  useEffect(() => {
    const query = options.query.trim()
    const file = fileMode ? fileRef.current : null
    if (query === '' || source.kind !== 'text' || (file === null && text.length < LARGE_TEXT_CHARS)) {
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
    const onProgress = (progress: number): void => {
      setDeep(current => ({ progress, matches: current?.matches ?? 0 }))
    }
    const scan = file !== null && absolutePath !== undefined
      ? scanCsvFile(absolutePath, pattern, { signal: controller.signal, onProgress })
      : scanText(text, pattern, { signal: controller.signal, onProgress })
    void scan.then((result) => {
      if (!controller.signal.aborted) setDeep({ progress: 1, matches: result.matches })
    }).catch(() => { /* aborted, or the file went away */ })
    return () => { controller.abort() }
  }, [options.query, options.regex, options.caseSensitive, text.length, source.kind, fileMode, absolutePath])

  if (buffer === null || view === null) {
    const empty = source.kind === 'text' && eof && text.length === 0
    return (
      <div style={PANE_FILL}>
        {empty ? t('csv.empty') : t('common.loading')}
      </div>
    )
  }

  const dataRows = windowed ? Math.max(0, totalRows - 1) : view.body.length
  // Rows keep their one natural box: the proportional mode moves the scrollbar, not the
  // typography.
  const lineBox = { lineHeight: `${String(ROW_HEIGHT - 2)}px` } as const
  const indexCell = { ...indexStyle, ...lineBox }
  const bodyCell = { ...cellStyle, ...lineBox }

  // What to paint, in body-row coordinates. A `null` cell list is a row whose window
  // has not been read yet: it keeps its height and shows nothing.
  const band = geometry === undefined
    ? undefined
    : stickyBand(logical, bodyRows, geometry.visibleRows, ROW_HEIGHT, OVERSCAN)
  const body = band === undefined
    ? windowed
      ? windowedBodyRows(
        win.rows,
        win.startRow,
        totalRows,
        // Always the viewport band: a window holds 5,000 rows, the table paints a screen.
        windowRange({ scrollTop, viewportHeight, rowCount: Math.max(0, totalRows - 1), rowHeight: ROW_HEIGHT, overscan: OVERSCAN }),
        ROW_HEIGHT,
        win.loading,
        view.columns,
      )
      : plainBodyRows(visibleIndices, view.body, scrollTop, viewportHeight)
    : {
      rows: bandRows(win.rows, win.startRow, band.first, band.first + band.count, win.loading, view.columns),
      topPad: 0,
      bottomPad: 0,
    }
  const topPad = body.topPad
  const bottomPad = body.bottomPad
  // While a window is being read, rows the delivered text already holds fill in: the
  // open of a big file switches source under the same first screen, and an empty frame
  // there is a visible flicker for no reason.
  const painted = windowed && win.loading
    ? body.rows.map(row => (row.cells === null && row.index < view.body.length
      ? { index: row.index, cells: fitColumns(view.body[row.index] ?? [], view.columns) }
      : row))
    : body.rows
  // A window read past the built index has real rows but estimated numbers.
  const estimated = windowed && !win.exact

  // Aborting drops the progress line; the rows already highlighted stay.
  const cancelScan = (): void => { setDeep(undefined) }

  // Only a real condition is worth a label here: a line past the cap, the row budget of
  // the non-windowed path, or the background walk that will make the row count exact.
  const status = deep !== undefined
    ? (deep.progress >= 1
        ? t('csv.scanDone', { count: deep.matches.toLocaleString('en-US') })
        : t('csv.scanProgress', { percent: Math.round(deep.progress * 100), count: deep.matches.toLocaleString('en-US') }))
    : buffer.overlong || win.overlong
    ? t('csv.lineTooLong', { limit: LIMITS.csvLineChars.toLocaleString('en-US') })
    : fileMode && !fileState.complete
    ? t('csv.indexProgress', { percent: Math.round(fileState.progress * 100) })
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
        // The pinned table changes under the browser's scroll anchoring; it must not
        // "correct" our offset behind our back.
        style={{ flex: '1 1 auto', overflow: 'auto', overflowAnchor: 'none' }}
      >
        <div style={geometry === undefined ? undefined : { height: geometry.contentHeight, position: 'relative' }}>
          <div style={geometry === undefined ? undefined : { position: 'sticky', top: 0, height: viewportHeight }}>
            <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--dsw-font-family)', fontSize: 12, whiteSpace: 'nowrap' }}>
              <thead>
                <tr>
                  <th style={cornerStyle} />
                  {view.header.map((value, column) => (
                    <th key={column} style={headerStyle}>{value || t('csv.column', { index: column + 1 })}</th>
                  ))}
                </tr>
              </thead>
              <tbody style={band === undefined ? undefined : { transform: `translateY(${String(-band.offset)}px)` }}>
                {topPad > 0 && (
                  <tr style={{ height: topPad }}>
                    <td colSpan={view.columns + 1} style={spacerCell} />
                  </tr>
                )}
                {painted.map((row) => {
                  if (row.cells === null) {
                    return (
                      <tr key={row.index} style={{ height: ROW_HEIGHT }}>
                        <td colSpan={view.columns + 1} style={spacerCell} />
                      </tr>
                    )
                  }
                  const active = row.index === found.activeRow
                  return (
                    <tr
                      key={row.index}
                      data-row-index={row.index}
                      style={{ height: ROW_HEIGHT, background: active ? ACTIVE_ROW : undefined }}
                    >
                      <td style={active ? { ...indexCell, background: ACTIVE_ROW } : indexCell}>
                        {estimated ? `~${String(row.index + 1)}` : row.index + 1}
                      </td>
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
        </div>
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
