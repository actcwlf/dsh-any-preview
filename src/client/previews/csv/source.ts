/**
 * Where the table's rows come from.
 *
 * Two sources behind one interface: the owner's delivered text (parsed incrementally into
 * a budgeted buffer, with a line index so a window can be read from the nearest anchor),
 * and the file itself once it is too big to page. Both answer the same two questions —
 * "read rows [start, start+count)" and "scan the whole thing" — so the table above does
 * not care which one is live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PreviewBodyProps } from '../../kernel/types.ts'
import { createRowBuffer } from '../../kernel/text-pipeline.ts'
import type { RowBuffer } from '../../kernel/text-pipeline.ts'
import { createCsvIndex } from '../../kernel/csv-index.ts'
import type { CsvIndex } from '../../kernel/csv-index.ts'
import { readWindow } from '../../kernel/csv-window.ts'
import type { WindowRead } from '../../kernel/useWindowedRows.ts'
import { openCsvFile } from '../../kernel/csv-file.ts'
import type { CsvFile } from '../../kernel/csv-file.ts'
import { scanText } from '../../kernel/search-scan.ts'
import { fileSize } from '../../kernel/zip.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { detectDelimiter } from './detect.ts'

/** Rows the incremental buffer keeps before the windowed path takes over. */
const ROW_BUDGET = LIMITS.csvRows

/** Windowing takes over once the delivered text is large, or the row budget is hit. */
const LARGE_TEXT_CHARS = 2 * 1024 * 1024

/** One index anchor every N rows, so a jump scans at most that many rows. */
const INDEX_STRIDE = 10_000

/** Where the file-backed source stands. `failed` means the text path keeps the table. */
type FileStatus = 'idle' | 'opening' | 'ready' | 'failed'

/** File source state the table renders from. */
interface FileState {
  readonly status: FileStatus
  /** Best-known rows, header included. */
  readonly total: number
  /** Fraction of the file walked so far, 0..1. */
  readonly progress: number
  readonly complete: boolean
}

const IDLE_FILE: FileState = { status: 'idle', total: 0, progress: 0, complete: false }
const OPENING_FILE: FileState = { status: 'opening', total: 0, progress: 0, complete: false }
const FAILED_FILE: FileState = { status: 'failed', total: 0, progress: 0, complete: false }

/** The header and body of the delivered text, widened so the grid lines up. */
export interface CsvView {
  readonly header: readonly string[]
  readonly body: readonly (readonly string[])[]
  readonly columns: number
}

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

/** Everything the table reads, and the two ways to read it. */
export interface CsvSource {
  /** Rows parsed from the delivered text; null until the first page arrives. */
  readonly view: CsvView | null
  /** Field separator detected from the text, so the file source uses the same one. */
  readonly delimiter: string
  /** True when the table reads windows instead of holding every row. */
  readonly windowed: boolean
  /** True when the file itself is the source. */
  readonly fileMode: boolean
  /** Best-known file rows (header included). */
  readonly fileRows: number
  /** Rows the delivered text holds (header included). */
  readonly textRows: number
  /** How much of the file the background walk has counted, 0..1. */
  readonly fileProgress: number
  readonly fileComplete: boolean
  /** True when a row in the delivered text passed the line cap. */
  readonly overlong: boolean
  /** True when the text buffer stopped at its row budget. */
  readonly truncated: boolean
  /** Length of the delivered text, for effects that must react to a new page. */
  readonly textLength: number
  /** Reads `count` file rows from `startRow` (header included). */
  readonly read: (startRow: number, count: number) => Promise<WindowRead>
  /** Bumps when the rows or their numbering change; drops cached windows. */
  readonly revision: number
  /** Names the live source, so a cache entry is dropped when it switches. */
  readonly sourceKey: string
  /** Whole-file scan, or undefined when the rows in memory are the whole story. */
  readonly scan: ((pattern: RegExp, options: {
    readonly signal: AbortSignal
    readonly from: number
    readonly lineLimit: number
    readonly onSlice: (progress: number, matches: number, lines: readonly number[]) => void
  }) => Promise<{ readonly matches: number, readonly lines: readonly number[] }>) | undefined
}

/**
 * Parse the delivered text and, when the file is too big to page, read it directly.
 * @param props - the preview body's inputs (content, address, resource hook).
 * @returns the rows, their numbering, and the readers.
 */
export function useCsvSource(props: PreviewBodyProps): CsvSource {
  const { content, resourceAddress, useResource } = props
  const text = content.kind === 'text' ? content.text : ''
  const eof = content.kind === 'text' ? content.eof : false
  // The file's Host path, when the owner reports one: it is what lets the table read
  // the file itself instead of waiting for page after page.
  const { absolutePath } = useDocument(content, resourceAddress, useResource)

  const bufferRef = useRef<RowBuffer | null>(null)
  const indexRef = useRef<CsvIndex | null>(null)
  const delimiterRef = useRef<string>(',')
  const consumedRef = useRef(0)
  const fileRef = useRef<CsvFile | null>(null)
  const openedRef = useRef<string | null>(null)
  const [fileState, setFileState] = useState<FileState>(IDLE_FILE)

  const isText = content.kind === 'text'

  // Consume during render: parsing is a pure fold over the new suffix, and the
  // `consumed` cursor makes a repeated render (StrictMode) a no-op. Doing this
  // in an effect would show an empty first frame and break server rendering.
  if (isText && bufferRef.current === null && text.length > 0) {
    delimiterRef.current = detectDelimiter(text)
    bufferRef.current = createRowBuffer(delimiterRef.current, ROW_BUDGET, LIMITS.csvLineChars)
  }
  const buffer = bufferRef.current
  if (buffer !== null && isText) {
    if (text.length > consumedRef.current) {
      // Only the new suffix is parsed; the prefix is never revisited.
      buffer.push(text.slice(consumedRef.current))
      consumedRef.current = text.length
    }
    if (eof && !buffer.complete) buffer.finish()
  }

  // The sparse index accumulates the same way: row boundaries (quote-aware) that let
  // a window be read from the nearest anchor instead of from the start of the file.
  if (isText && text.length > 0) {
    if (indexRef.current === null) indexRef.current = createCsvIndex(INDEX_STRIDE)
    indexRef.current.push(text)
  }
  const index = indexRef.current

  // Normalizing the whole grid is O(rows); memoize it so a scroll tick only
  // re-renders the window slice.
  const view = useMemo<CsvView | null>(() => {
    if (buffer === null) return null
    const grid = buffer.rows
    const { cells, columns } = normalize([grid[0] ?? [], ...grid.slice(1)])
    return { header: cells[0] ?? [], body: cells.slice(1), columns }
  }, [buffer, buffer?.rows.length])

  const fileMode = fileState.status === 'ready'
  const textWindowed = isText && (text.length > LARGE_TEXT_CHARS || buffer?.truncated === true)

  // Rows in the file, header included. `index.rows` counts newlines, so a last line
  // without one is an extra row — the rule the parser's `finish` also applies.
  const openLastLine = text.length > 0 && !text.endsWith('\n')
  const indexedRows = (index?.rows ?? 0) + (eof && openLastLine ? 1 : 0)
  // Every delivered page is indexed synchronously, so this estimate is already the
  // exact count of what arrived.
  const estimatedRows = Math.max(buffer?.rows.length ?? 1, index?.estimateRows(text.length) ?? 1, 1)
  const textRows = Math.max(indexedRows, estimatedRows)

  // A file too big to page gets its own source: probe the size once, and only take the
  // file path for a file too big to page. Small files keep the instant text path.
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

  // One window, from the file when there is one and from the delivered text otherwise.
  // The callback is read through a ref by the hook, so its identity does not matter.
  const read = useCallback(async (startRow: number, count: number): Promise<WindowRead> => {
    const file = fileRef.current
    if (fileMode && file !== null) {
      try {
        const window = await file.read(startRow, count)
        return { rows: window.rows, overlong: window.overlong, exact: window.exact }
      } catch (error) {
        // The file source broke mid-session (route gone, file changed): hand the table
        // back to the delivered text instead of leaving it on placeholders.
        setFileState(FAILED_FILE)
        throw error
      }
    }
    if (indexRef.current === null) return { rows: [], overlong: false, exact: true }
    const window = readWindow(text, indexRef.current, startRow, count, delimiterRef.current, LIMITS.csvLineChars)
    return { rows: window.rows, overlong: window.overlong, exact: true }
  }, [fileMode, text])

  const scan = useCallback((pattern: RegExp, options: {
    readonly signal: AbortSignal
    readonly from: number
    readonly lineLimit: number
    readonly onSlice: (progress: number, matches: number, lines: readonly number[]) => void
  }) => {
    const file = fileRef.current
    if (fileMode && file !== null) return file.scan(pattern, options)
    return scanText(text, pattern, options)
  }, [fileMode, text])

  // A window cannot hide rows — it never holds the whole file — so a windowed table
  // keeps the highlight and drops filtering rather than filtering only what it can see.
  const windowed = textWindowed || fileMode
  const searchable = fileMode || (isText && text.length >= LARGE_TEXT_CHARS)

  return {
    view,
    delimiter: delimiterRef.current,
    windowed,
    fileMode,
    fileRows: fileState.total,
    textRows,
    fileProgress: fileState.progress,
    fileComplete: fileState.complete,
    overlong: buffer?.overlong === true,
    truncated: buffer?.truncated === true,
    textLength: text.length,
    read,
    // Cached windows hold rows, not counts: only a change of the rows or of their
    // numbering has to drop them. The background walk changes neither until it finishes,
    // so it must not clear the cache on every slice — that is what blanked the table
    // while indexing. Completion is the one moment the numbers become exact.
    revision: fileMode ? (fileState.complete ? 1 : 0) : text.length,
    sourceKey: fileMode ? 'file' : 'text',
    scan: searchable ? scan : undefined,
  }
}
