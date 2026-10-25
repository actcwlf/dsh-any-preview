/** Line-delimited JSON viewer: one row per record, bad lines shown as raw text. */
import { useMemo, useState } from 'react'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { filterRows } from '../../kernel/search.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { collectColumns, createJsonlConsumer, formatValue } from './parse.ts'

/** Rows rendered at once; the rest are counted, not mounted. */
const DISPLAY_ROWS = 2_000

export function JsonlBody({ content, scrollportRef }: PreviewBodyProps) {
  const jsonl = useStreamedText(content, () => createJsonlConsumer())
  const [query, setQuery] = useState('')
  const records = jsonl?.records ?? []
  const filtered = useMemo(
    () => filterRows(records, query, record => record.raw),
    [records, records.length, query],
  )

  if (jsonl === null) {
    return <div style={emptyStyle}>正在读取…</div>
  }

  const columns = collectColumns(jsonl.records)
  const shown = filtered.rows.slice(0, DISPLAY_ROWS)
  const shownIndices = filtered.indices.slice(0, DISPLAY_ROWS)
  const hidden = filtered.rows.length - shown.length

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)' }}>
      <div style={barStyle}>
        <span>
          {jsonl.records.length.toLocaleString('en-US')} 条记录
          {columns.length === 0 ? '（非对象行）' : ` × ${String(columns.length)} 字段`}
          {jsonl.invalid > 0 && (
            <span style={{ color: 'rgb(248, 81, 73)' }}> · {jsonl.invalid.toLocaleString('en-US')} 坏行</span>
          )}
        </span>
        <SearchBar
          value={query}
          onChange={setQuery}
          matches={filtered.rows.length}
          total={jsonl.records.length}
        />
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {jsonl.truncated
            ? '已截断'
            : hidden > 0 ? `仅显示前 ${DISPLAY_ROWS.toLocaleString('en-US')} 条` : ''}
        </span>
      </div>
      <div ref={scrollportRef} style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--dsw-font-family)', fontSize: 12, whiteSpace: 'nowrap' }}>
          <thead>
            <tr>
              <th style={cornerStyle} />
              {columns.map(column => (
                <th key={column} style={headerStyle}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((record, offset) => (
              record.error === undefined
                ? (
                    <tr key={shownIndices[offset]} style={{ height: 22 }}>
                      <td style={indexStyle}>{record.line}</td>
                      {columns.map((column) => (
                        <td key={column} style={cellStyle}>{cellOf(record.value, column)}</td>
                      ))}
                    </tr>
                  )
                : (
                    <tr key={shownIndices[offset]} style={{ height: 22, background: 'rgba(248, 81, 73, 0.14)' }}>
                      <td style={indexStyle}>{record.line}</td>
                      <td colSpan={Math.max(1, columns.length)} style={{ ...cellStyle, color: 'rgb(248, 81, 73)' }}>
                        {record.raw}
                      </td>
                    </tr>
                  )
            ))}
          </tbody>
        </table>
      </div>
    </div>
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

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

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
} as const

const cornerStyle = { ...headerStyle, left: 0, zIndex: 2, width: 1 }

const indexStyle = {
  padding: '0 10px',
  lineHeight: '20px',
  textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  position: 'sticky' as const,
  left: 0,
  background: 'var(--dsw-alias-bg-base)',
  userSelect: 'none' as const,
} as const

const cellStyle = {
  padding: '0 12px',
  lineHeight: '20px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const emptyStyle = {
  height: '100%', display: 'grid', placeItems: 'center', fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
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
