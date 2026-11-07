/**
 * Log input source: delivered text for small files, a row-file for large ones.
 *
 * The file source reuses the same byte-anchor / window machinery as CSV; the only
 * format-specific part is that each line becomes a one-cell row.
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
import { createLogConsumer } from './parse.ts'
import { parseLogSlice } from './rows.ts'

/** Text larger than this attempts the file-backed path. */
const LARGE_TEXT_CHARS = 2 * 1024 * 1024

/** What the log body needs from its source. */
export interface LogSource {
  /** Lines for the delivered-text path. */
  readonly lines: readonly string[]
  /** True when a file-backed window source is active. */
  readonly windowed: boolean
  readonly totalRows: number
  readonly progress: number
  readonly complete: boolean
  readonly truncated: boolean
  readonly revision: number
  readonly sourceKey: string
  readonly read: (startRow: number, count: number) => Promise<WindowRead>
}

/**
 * Open a log from the delivered text, or from the file when it is too large to page.
 * @param props - preview body props.
 * @returns lines, file windows and readiness.
 */
export function useLogSource(props: PreviewBodyProps): LogSource {
  const { content, resourceAddress, useResource } = props
  const { meta, absolutePath } = useDocument(content, resourceAddress, useResource)
  const streamed = useStreamedText(content, () => createLogConsumer())
  const lines = streamed?.lines ?? []

  const fileRef = useRef<RowFile | null>(null)
  const openedRef = useRef<string | null>(null)
  const [fileMode, setFileMode] = useState(false)
  const [totalRows, setTotalRows] = useState(0)
  const [progress, setProgress] = useState(0)
  const [complete, setComplete] = useState(false)
  const [revision, setRevision] = useState(0)
  const [sourceKey, setSourceKey] = useState('text')

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
        const file = await openRowFile(path, { parse: parseLogSlice }, controller.signal)
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
      } catch {
        // Keep the delivered-text path; a file the Host cannot serve is still viewable.
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

  // Count the rest of the file in the background so the scrollbar and line count
  // become exact without delaying the first window.
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
    lines,
    windowed: fileMode,
    totalRows: fileMode ? totalRows : lines.length,
    progress,
    complete: fileMode ? complete : streamed?.complete === true,
    truncated: !fileMode && streamed?.truncated === true,
    revision: fileMode ? revision : lines.length,
    sourceKey,
    read,
  }
}
