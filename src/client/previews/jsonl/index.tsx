/** Line-delimited JSON viewer: one row per record, bad lines shown as raw text. */
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useEffect, useMemo, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { ACTIVE_ROW } from '../../kernel/layout.ts'
import { DATA_TABLE_HEADER } from '../../kernel/ui.ts'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { useWindowedRows } from '../../kernel/useWindowedRows.ts'
import { stickyBand } from '../../kernel/window-state.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useLogScroll } from '../log/scroll.ts'
import { collectColumns, formatValue, parseJsonlRecord } from './parse.ts'
import type { JsonlRecord } from './parse.ts'
import { useJsonlSource } from './source.ts'

/** Small-table rows rendered at once; the rest are counted, not mounted. */
const DISPLAY_ROWS = 2_000

/** One JSONL row height. */
const ROW_HEIGHT = 22

/** Space above/below the visible window. */
const OVERSCAN = 40

export function JsonlBody(props: PreviewBodyProps) {
  useLocale()
  const source = useJsonlSource(props)
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const scroll = useLogScroll({
    scrollportRef: props.scrollportRef,
    ready: source.windowed || source.records.length > 0,
    totalRows: source.totalRows,
    rowHeight: ROW_HEIGHT,
  })
  const win = useWindowedRows({
    read: source.read,
    revision: source.revision,
    source: source.sourceKey,
    enabled: source.windowed,
    scrollTop: scroll.scrollTop,
    viewportHeight: scroll.viewportHeight,
    totalRows: source.totalRows,
    rowHeight: scroll.mappingPitch,
    windowSize: 5_000,
    settleMs: 200,
  })
  const windowRecords = useMemo(() => {
    const records: JsonlRecord[] = []
    win.rows.forEach((row, offset) => {
      const record = parseJsonlRecord(win.startRow + offset + 1, row[0] ?? '')
      if (record !== undefined) records.push(record)
    })
    return records
  }, [win.rows, win.startRow])
  const records = source.windowed ? windowRecords : source.records
  const columns = source.windowed
    ? (source.columns.length > 0 ? source.columns : collectColumns(windowRecords))
    : collectColumns(records)
  const found = useSearch(useMemo(() => records.map(record => record.raw), [records, records.length]), options)
  const activeRow = found.activeRow === undefined
    ? undefined
    : (records[found.activeRow]?.line ?? 1) - 1

  const visible = useMemo(() => {
    if (!filter || found.pattern === undefined) return records.map((record, index) => ({ record, index }))
    return found.matches.map(index => ({ record: records[index]!, index }))
  }, [records, records.length, filter, found.pattern, found.matches])

  useEffect(() => {
    if (activeRow === undefined) return
    scroll.reveal(activeRow)
  }, [activeRow, scroll.reveal])

  if (!source.windowed && source.records.length === 0) {
    return <PreviewState kind="JSONL" title={t('common.loading')} message={t('common.loading')} />
  }

  const shown = source.windowed ? records : visible.slice(0, DISPLAY_ROWS).map(item => item.record)
  const hidden = source.windowed ? 0 : visible.length - shown.length
  const pinned = source.windowed && scroll.geometry !== undefined
  const band = pinned
    ? stickyBand(scroll.logical, source.totalRows, scroll.geometry.visibleRows, ROW_HEIGHT, OVERSCAN)
    : undefined
  const status = source.windowed
    ? source.complete ? undefined : t('jsonl.indexing', { percent: String(Math.round(source.progress * 100)) })
    : source.truncated
      ? t('common.truncated')
      : hidden > 0 ? t('jsonl.shown', { count: DISPLAY_ROWS.toLocaleString('en-US') }) : undefined
  const sourceRecords = source.records
  const count = source.windowed ? source.totalRows : sourceRecords.length
  const invalid = source.windowed ? 0 : sourceRecords.filter(record => record.error !== undefined).length

  return (
    <PreviewChrome
      kind="JSONL"
      title={(
        <span>
          {t('jsonl.records', { count: count.toLocaleString('en-US') })}
          {columns.length === 0 ? t('jsonl.nonObject') : t('jsonl.fields', { count: columns.length })}
          {invalid > 0 && (
            <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>
              {t('jsonl.invalid', { count: invalid.toLocaleString('en-US') })}
            </span>
          )}
        </span>
      )}
      toolbar={compact => (
        <SearchBar
          compact={compact}
          options={options}
          onChange={setOptions}
          matches={found.matches.length}
          index={found.index}
          total={count}
          onPrev={found.prev}
          onNext={found.next}
          filter={filter}
          onFilter={setFilter}
          filterable={!source.windowed}
          placeholder={source.windowed ? t('jsonl.windowSearch') : undefined}
        />
      )}
      status={status}
      tone={status === undefined ? 'normal' : 'warning'}
    >
      <div
        ref={scroll.bindScroller}
        style={{ flex: '1 1 auto', overflow: 'auto', overflowAnchor: 'none' }}
      >
        <JsonlTable
          columns={columns}
          records={shown}
          startRow={source.windowed ? win.startRow : 0}
          totalRows={source.windowed ? source.totalRows : shown.length}
          activeRow={activeRow}
          pattern={found.pattern}
          pinned={pinned}
          band={band}
          contentHeight={pinned ? scroll.contentHeight : undefined}
          viewportHeight={scroll.viewportHeight}
          loading={source.windowed && win.loading}
        />
      </div>
    </PreviewChrome>
  )
}

interface JsonlTableProps {
  readonly columns: readonly string[]
  readonly records: readonly JsonlRecord[]
  readonly startRow: number
  readonly totalRows: number
  readonly activeRow: number | undefined
  readonly pattern: RegExp | undefined
  readonly pinned: boolean
  readonly band: { readonly first: number, readonly count: number, readonly offset: number } | undefined
  readonly contentHeight: number | undefined
  readonly viewportHeight: number
  readonly loading: boolean
}

function JsonlTable(props: JsonlTableProps) {
  const { columns, records, startRow, totalRows, activeRow, pattern, pinned, band, contentHeight, viewportHeight } = props
  const byLine = useMemo(() => new Map(records.map(record => [record.line - 1, record])), [records])
  const rowFor = (index: number): JsonlRecord | undefined => byLine.get(index)
  const row = (record: JsonlRecord | undefined, key: string | number) => {
    if (record === undefined) {
      return (
        <tr key={key} style={{ height: ROW_HEIGHT }}>
          <td colSpan={columns.length + 1} />
        </tr>
      )
    }
    const active = record.line - 1 === activeRow
    const style = {
      height: ROW_HEIGHT,
      background: active
        ? ACTIVE_ROW
        : record.error === undefined
          ? undefined
          : 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
      boxShadow: active ? 'inset 3px 0 0 var(--dsw-alias-state-warn-primary)' : undefined,
    } as const
    if (record.error !== undefined) {
      return (
        <tr key={record.line} data-row-index={record.line - 1} style={style}>
          <td style={indexStyle}>{record.line}</td>
          <td colSpan={Math.max(1, columns.length)} style={{ ...cellStyle, color: 'var(--dsw-alias-state-error-primary)' }}>
            <Marked text={record.raw} pattern={pattern} emphasis={active} />
          </td>
        </tr>
      )
    }
    return (
      <tr key={record.line} data-row-index={record.line - 1} style={style}>
        <td style={indexStyle}>{record.line}</td>
        {columns.map(column => (
          <td key={column} style={cellStyle}>
            <Marked text={cellOf(record.value, column)} pattern={pattern} emphasis={active} />
          </td>
        ))}
      </tr>
    )
  }

  const header = (
    <thead>
      <tr>
        <th style={cornerStyle} />
        {columns.map(column => <th key={column} style={headerStyle}>{column}</th>)}
      </tr>
    </thead>
  )

  if (pinned && band !== undefined) {
    return (
      <div style={{ height: contentHeight, position: 'relative' }}>
        <div style={{ position: 'sticky', top: 0, height: viewportHeight, overflow: 'hidden' }}>
          <table style={tableStyle}>
            {header}
            <tbody style={{ transform: `translateY(${String(-band.offset)}px)` }}>
              {Array.from({ length: band.count }, (_value, offset) => {
                const index = band.first + offset
                return row(rowFor(index), index)
              })}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <table style={tableStyle}>
      {header}
      <tbody>
        {startRow > 0 && <tr style={{ height: startRow * ROW_HEIGHT }}><td colSpan={columns.length + 1} /></tr>}
        {records.map(record => row(record, record.line - 1))}
        {totalRows - startRow - records.length > 0 && (
          <tr style={{ height: (totalRows - startRow - records.length) * ROW_HEIGHT }}>
            <td colSpan={columns.length + 1} />
          </tr>
        )}
      </tbody>
    </table>
  )
}

/**
 * Read one column out of a parsed record value.
 * @param value - parsed line value.
 * @param column - column name.
 * @returns the formatted cell text.
 */
function cellOf(value: unknown, column: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  return formatValue((value as Record<string, unknown>)[column])
}

const tableStyle = {
  borderCollapse: 'collapse' as const,
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 12,
  whiteSpace: 'nowrap' as const,
} as const

const headerStyle = {
  ...DATA_TABLE_HEADER,
  position: 'sticky' as const,
  top: 0,
  zIndex: 1,
  textAlign: 'left' as const,
  verticalAlign: 'middle' as const,
} as const

const cornerStyle = { ...headerStyle, left: 0, zIndex: 2, width: 1 }

const indexStyle = {
  padding: '0 10px',
  lineHeight: '20px',
  textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  position: 'sticky' as const,
  left: 0,
  background: 'var(--dsw-alias-bg-base)',
  userSelect: 'none' as const,
} as const

const cellStyle = {
  padding: '0 16px',
  lineHeight: '20px',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
} as const

/** What the client entry registers for this format. */
export const jsonlPreview: PreviewModule = {
  id: 'dsh-any-preview/jsonl',
  extensions: ['jsonl', 'ndjson'],
  load: 'text-pages',
  wrap: false,
  title: () => 'JSONL',
  Body: JsonlBody,
}
