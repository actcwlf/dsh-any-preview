/**
 * JSONL source: delivered records for small files, a row-file for large ones.
 *
 * Large files use shared line-file indexing; each line stays a one-cell row and is
 * parsed into a record when it reaches the table.
 */
import { useCallback, useEffect, useState } from 'react'
import type { PreviewBodyProps } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { WindowRead } from '../../kernel/useWindowedRows.ts'
import { useLineFileSource } from '../../kernel/useLineFileSource.ts'
import type { RowFile } from '../../kernel/row-file.ts'
import { collectColumns, createJsonlConsumer, parseJsonlRecord } from './parse.ts'
import type { JsonlRecord } from './parse.ts'
import { parseJsonlSlice } from './rows.ts'
import { matchJsonlPage, scanJsonlText } from './search.ts'
import type { JsonlScanRunner } from './search.ts'

/** Records sampled for the stable column set of a large file. */
const COLUMN_SAMPLE = 200

/** What the body needs from a JSONL source. */
export interface JsonlSource {
  readonly records: readonly JsonlRecord[]
  /** True for the file-backed path (large files). */
  readonly fileMode: boolean
  /** Both paths render through a window; only the backing store differs. */
  readonly windowed: boolean
  readonly totalRows: number
  readonly columns: readonly string[]
  readonly progress: number
  readonly complete: boolean
  readonly truncated: boolean
  readonly revision: number
  readonly sourceKey: string
  readonly read: (startRow: number, count: number) => Promise<WindowRead>
  readonly scan: JsonlScanRunner
  readonly page: (pattern: RegExp, cursor: number, signal: AbortSignal, limit: number) => Promise<readonly number[]>
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
  const text = content.kind === 'text' ? content.text : ''
  const [columns, setColumns] = useState<readonly string[]>(() => collectColumns(records))

  useEffect(() => {
    if (records.length > 0 && columns.length === 0) setColumns(collectColumns(records))
  }, [records, records.length, columns.length])

  const sampleColumns = useCallback(async (file: RowFile): Promise<void> => {
    const head = await file.read(0, COLUMN_SAMPLE)
    const parsed: JsonlRecord[] = []
    head.rows.forEach((row, index) => {
      const record = parseJsonlRecord(index + 1, row[0] ?? '')
      if (record !== undefined) parsed.push(record)
    })
    const sampled = collectColumns(parsed)
    if (sampled.length > 0) setColumns(sampled)
  }, [])

  const file = useLineFileSource({
    absolutePath,
    metaSize: meta?.size,
    truncated: streamed?.truncated === true,
    parse: parseJsonlSlice,
    skipEmpty: true,
    text,
    scanText: scanJsonlText,
    pageText: matchJsonlPage,
    onOpen: sampleColumns,
  })

  const read = useCallback(async (startRow: number, count: number): Promise<WindowRead> => {
    if (file.fileMode) return file.read(startRow, count)
    return {
      rows: records.slice(startRow, startRow + count).map(record => [record.raw]),
      overlong: false,
      exact: true,
    }
  }, [file.fileMode, file.read, records])

  return {
    records,
    fileMode: file.fileMode,
    windowed: true,
    totalRows: file.fileMode ? file.totalRows : records.length,
    columns,
    progress: file.progress,
    complete: file.fileMode ? file.complete : streamed?.complete === true,
    truncated: !file.fileMode && streamed?.truncated === true,
    revision: file.fileMode ? file.revision : records.length,
    sourceKey: file.sourceKey,
    read,
    scan: file.scan,
    page: file.page,
  }
}
