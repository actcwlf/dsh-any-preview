/**
 * Log input source: delivered text for small files, a row-file for large ones.
 *
 * The format-specific part is only "one line becomes a one-cell row"; opening,
 * indexing and page cursors are shared with JSONL.
 */
import type { PreviewBodyProps } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { WindowRead } from '../../kernel/useWindowedRows.ts'
import { useLineFileSource } from '../../kernel/useLineFileSource.ts'
import { createLogConsumer } from './parse.ts'
import { parseLogSlice } from './rows.ts'
import { matchLogPage, scanLogText } from './search.ts'
import type { LogPageRunner, LogScanRunner } from './scan.ts'

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
  readonly scan: LogScanRunner
  readonly page: LogPageRunner
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
  const text = content.kind === 'text' ? content.text : ''
  const file = useLineFileSource({
    absolutePath,
    metaSize: meta?.size,
    truncated: streamed?.truncated === true,
    parse: parseLogSlice,
    skipEmpty: false,
    text,
    scanText: scanLogText,
    pageText: matchLogPage,
  })

  return {
    lines,
    windowed: file.fileMode,
    totalRows: file.fileMode ? file.totalRows : lines.length,
    progress: file.progress,
    complete: file.fileMode ? file.complete : streamed?.complete === true,
    truncated: !file.fileMode && streamed?.truncated === true,
    revision: file.fileMode ? file.revision : lines.length,
    sourceKey: file.sourceKey,
    read: file.read,
    scan: file.scan,
    page: file.page,
  }
}
