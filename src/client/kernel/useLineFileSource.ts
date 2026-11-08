/**
 * A line-oriented file source shared by log and JSONL.
 *
 * The format supplies how a slice becomes rows and how a page of the delivered text is
 * searched; opening, size probing, background indexing and page cursors stay here.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fileSize } from './zip.ts'
import { fileUrl } from './file-url.ts'
import { openRowFile } from './row-file.ts'
import type { RowFile, RowParse } from './row-file.ts'
import type { WindowRead } from './useWindowedRows.ts'

/** Text larger than this attempts the file-backed path. */
const LARGE_TEXT_CHARS = 2 * 1024 * 1024

/** What one whole-text line scan can publish. */
export interface LineScanOptions {
  readonly signal: AbortSignal
  readonly lineLimit: number
  readonly onSlice: (progress: number, matches: number, lines: readonly number[]) => void
}

/** One whole-text line scan. */
export interface LineScanResult {
  readonly matches: number
  readonly lines: readonly number[]
  readonly pages: readonly number[]
}

/** A text scan callback supplied by the format. */
export type TextLineScan = (text: string, pattern: RegExp, options: LineScanOptions) => Promise<LineScanResult>

/** A text page callback supplied by the format. */
export type TextLinePage = (
  text: string,
  pattern: RegExp,
  cursor: number,
  limit: number,
) => Promise<readonly number[]>

/** What the line source needs from the format and the document owner. */
export interface LineFileSourceOptions {
  readonly absolutePath: string | undefined
  readonly metaSize: number | undefined
  /** The text consumer hit its line/record budget. */
  readonly truncated: boolean
  readonly parse: RowParse
  readonly skipEmpty: boolean
  readonly text: string
  readonly scanText: TextLineScan
  readonly pageText: TextLinePage
  /** Hook for format-specific work once the file opens, e.g. sampling columns. */
  readonly onOpen?: (file: RowFile) => void | Promise<void>
}

/** What log/JSONL need from the file source. */
export interface LineFileSource {
  readonly fileMode: boolean
  readonly totalRows: number
  readonly progress: number
  readonly complete: boolean
  readonly revision: number
  readonly sourceKey: string
  readonly read: (startRow: number, count: number) => Promise<WindowRead>
  readonly scan: (pattern: RegExp, options: LineScanOptions) => Promise<LineScanResult>
  readonly page: (pattern: RegExp, cursor: number, signal: AbortSignal, limit: number) => Promise<readonly number[]>
}

/**
 * Open the file when needed and expose windows, whole-file line scans and page reads.
 * @param options - format callbacks and document identity.
 * @returns the file-backed source.
 */
export function useLineFileSource(options: LineFileSourceOptions): LineFileSource {
  const { absolutePath, metaSize, truncated, parse, skipEmpty, text, scanText, pageText, onOpen } = options
  const fileRef = useRef<RowFile | null>(null)
  const openedRef = useRef<string | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const [fileMode, setFileMode] = useState(false)
  const [totalRows, setTotalRows] = useState(0)
  const [progress, setProgress] = useState(0)
  const [complete, setComplete] = useState(false)
  const [revision, setRevision] = useState(0)
  const [sourceKey, setSourceKey] = useState('text')

  useEffect(() => {
    const path = absolutePath
    if (path === undefined || openedRef.current === path) return undefined
    const controller = new AbortController()
    let live = true
    void (async () => {
      try {
        const url = fileUrl(path)
        const size = url === undefined
          ? undefined
          : (metaSize !== undefined && metaSize > 0 ? metaSize : await fileSize(url))
        // A line cap is also a reason to leave the text path.
        if (!truncated && (size === undefined || size <= LARGE_TEXT_CHARS)) return
        openedRef.current = path
        const file = await openRowFile(path, { parse }, controller.signal)
        if (!live) {
          file.dispose()
          return
        }
        fileRef.current = file
        setFileMode(true)
        setSourceKey(`file:${path}`)
        setTotalRows(file.totalRows())
        setProgress(file.size > 0 ? file.scanned / file.size : 1)
        setComplete(file.complete)
        setRevision(value => value + 1)
        if (onOpenRef.current !== undefined) await onOpenRef.current(file)
      } catch {
        // Keep the delivered-text path; a Host route failure must not hide the data.
      }
    })()
    return () => {
      live = false
      controller.abort()
      fileRef.current?.dispose()
      fileRef.current = null
      setFileMode(false)
      openedRef.current = null
    }
  }, [absolutePath, metaSize, truncated, parse])

  useEffect(() => {
    if (!fileMode) return undefined
    let live = true
    let published = progress
    const step = (): void => {
      const file = fileRef.current
      if (!live || file === null) return
      void file.advance().then((more) => {
        if (!live) return
        const nextProgress = file.size > 0 ? file.scanned / file.size : 1
        if (file.complete || nextProgress - published >= 0.02) {
          published = nextProgress
          setProgress(nextProgress)
          setTotalRows(file.totalRows())
          setComplete(file.complete)
          setRevision(value => value + 1)
        }
        if (more) setTimeout(step, 0)
      }).catch(() => {
        if (live) setComplete(true)
      })
    }
    const timer = setTimeout(step, 0)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [fileMode])

  const read = useCallback(async (startRow: number, count: number): Promise<WindowRead> => {
    const file = fileRef.current
    if (file === null) return { rows: [], overlong: false, exact: true }
    const window = await file.read(startRow, count)
    return { rows: window.rows, overlong: window.overlong, exact: window.exact }
  }, [])

  const scan = useCallback(async (pattern: RegExp, scanOptions: LineScanOptions): Promise<LineScanResult> => {
    const file = fileRef.current
    if (file !== null) {
      const result = await file.scanLines(pattern, { ...scanOptions, skipEmpty })
      return { matches: result.matches, lines: result.lines, pages: result.pages }
    }
    return scanText(textRef.current, pattern, scanOptions)
  }, [scanText, skipEmpty])

  const page = useCallback(async (
    pattern: RegExp,
    cursor: number,
    signal: AbortSignal,
    limit: number,
  ): Promise<readonly number[]> => {
    const file = fileRef.current
    if (file !== null) return file.scanPageLines(pattern, { signal, cursor, limit, skipEmpty })
    return pageText(textRef.current, pattern, cursor, limit)
  }, [pageText, skipEmpty])

  return {
    fileMode,
    totalRows: fileMode ? totalRows : 0,
    progress,
    complete: fileMode ? complete : false,
    revision: fileMode ? revision : 0,
    sourceKey,
    read,
    scan,
    page,
  }
}
