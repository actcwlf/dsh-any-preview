/**
 * JSONL source: delivered records for small files, a row-file for large ones.
 *
 * Large files use the same byte-anchor / window machinery as CSV and log; each
 * line stays a one-cell row and is parsed into a record when it reaches the table.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreviewBodyProps } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import { openRowFile } from '../../kernel/row-file.ts'
import type { RowFile } from '../../kernel/row-file.ts'
import type { WindowRead } from '../../kernel/useWindowedRows.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { fileSize } from '../../kernel/zip.ts'
import { collectColumns, createJsonlConsumer, parseJsonlRecord } from './parse.ts'
import type { JsonlRecord } from './parse.ts'
import { parseJsonlSlice } from './rows.ts'

/** Text larger than this attempts the file-backed path. */
const LARGE_TEXT_CHARS = 2 * 1024 * 1024

/** Records sampled for the stable column set of a large file. */
const COLUMN_SAMPLE = 200

/** What the body needs from a JSONL source. */
export interface JsonlSource {
  readonly records: readonly JsonlRecord[]
  readonly windowed: boolean
  readonly totalRows: number
  readonly columns: readonly string[]
  readonly progress: number
  readonly complete: boolean
  readonly truncated: boolean
  readonly revision: number
  readonly sourceKey: string
  readonly read: (startRow: number, count: number) => Promise<WindowRead>
}

/**
 * Open JSONL from the delivered text, or from the file when it is too large to page.
 * @param props - preview body props.
 * @returns records, columns and file windows.
 */
export function useJsonlSource(props: PreviewBodyProps): JsonlSource {
  const { content, resourceAddress, useResource } = props
  const { meta, absolutePath } = useDocument(content, resourceAddress, useResource)
  const streamed = useStreamedText(content, () => createJsonlConsumer())
  const records = streamed?.records ?? []
  const [columns, setColumns] = useState<readonly string[]>(() => collectColumns(records))

  const fileRef = useRef<RowFile | null>(null)
  const openedRef = useRef<string | null>(null)
  const [fileMode, setFileMode] = useState(false)
  const [totalRows, setTotalRows] = useState(0)
  const [progress, setProgress] = useState(0)
  const [complete, setComplete] = useState(false)
  const [revision, setRevision] = useState(0)
  const [sourceKey, setSourceKey] = useState('text')

  useEffect(() => {
    if (!fileMode && records.length > 0 && columns.length === 0) {
      setColumns(collectColumns(records))
    }
  }, [fileMode, records, records.length, columns.length])

  useEffect(() => {
    const path = absolutePath
    if (path === undefined || openedRef.current === path) return undefined
    openedRef.current = path
    const controller = new AbortController()
    let live = true
    void (async () => {
      try {
        const url = fileUrl(path)
        const size = url === undefined
          ? undefined
          : (meta?.size !== undefined && meta.size > 0 ? meta.size : await fileSize(url))
        if (size === undefined || size <= LARGE_TEXT_CHARS) return
        const file = await openRowFile(path, { parse: parseJsonlSlice }, controller.signal)
        if (!live) {
          file.dispose()
          return
        }
        fileRef.current = file
        setFileMode(true)
        setSourceKey('file')
        setTotalRows(file.totalRows())
        setProgress(file.size > 0 ? file.scanned / file.size : 1)
        setComplete(file.complete)
        setRevision(value => value + 1)
        const head = await file.read(0, COLUMN_SAMPLE)
        const parsed: JsonlRecord[] = []
        head.rows.forEach((row, index) => {
          const record = parseJsonlRecord(index + 1, row[0] ?? '')
          if (record !== undefined) parsed.push(record)
        })
        const sampled = collectColumns(parsed)
        if (sampled.length > 0) setColumns(sampled)
      } catch {
        // Fall back to the delivered text; a Host route failure must not hide the data.
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
  }, [absolutePath, meta?.size])

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

  return {
    records,
    windowed: fileMode,
    totalRows: fileMode ? totalRows : records.length,
    columns,
    progress,
    complete: fileMode ? complete : streamed?.complete === true,
    truncated: !fileMode && streamed?.truncated === true,
    revision: fileMode ? revision : records.length,
    sourceKey,
    read,
  }
}
