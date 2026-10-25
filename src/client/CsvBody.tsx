/** Renderer body for CSV/TSV inside the Sidebar's document pane. */
import { useMemo, useState } from 'react'
import { detectDelimiter, parseDelimited } from './parse.ts'
import type { ParsedTable } from './parse.ts'

/** The text half of the document owner's content union. */
interface DocumentTextContent {
  readonly kind: 'text'
  readonly text: string
  readonly eof: boolean
}

/** Props this body reads from `sidebar.right.tab.document`. */
interface CsvBodyProps {
  readonly content: DocumentTextContent | { readonly kind: 'bytes', readonly data: Uint8Array }
  readonly scrollportRef?: (element: HTMLElement | null) => void
}

const PAGE_ROWS = 500

const DELIMITER_LABEL: Record<string, string> = {
  ',': '逗号',
  '\t': '制表符',
  ';': '分号',
  '|': '竖线',
}

/** Read the accumulated text, tolerating the bytes variant. */
function textOf(content: CsvBodyProps['content']): string {
  return content.kind === 'text' ? content.text : ''
}

/** Full-width normalization so ragged rows still line up under the header. */
function normalize(rows: readonly string[][]): { cells: readonly string[][], columns: number } {
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  return {
    cells: rows.map(row => (row.length === columns ? row : [...row, ...Array<string>(columns - row.length).fill('')])),
    columns,
  }
}

export function CsvBody({ content, scrollportRef }: CsvBodyProps) {
  const [limit, setLimit] = useState(PAGE_ROWS)
  const text = textOf(content)
  const eof = content.kind === 'text' ? content.eof : true

  const view = useMemo(() => {
    if (text.length === 0) return undefined
    const delimiter = detectDelimiter(text)
    const parsed: ParsedTable = parseDelimited(text, delimiter, limit + 1)
    // While pages stream in the final row is a fragment; drop it until eof.
    const rows = parsed.truncated || eof ? parsed.rows : parsed.rows.slice(0, -1)
    if (rows.length === 0) return undefined
    const { cells, columns } = normalize(rows)
    return { delimiter, header: cells[0]!, body: cells.slice(1), columns, more: parsed.truncated || !eof }
  }, [text, eof, limit])

  if (view === undefined) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
        正在读取…
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
      }}>
        <span>{view.body.length} 行 × {view.columns} 列 · 分隔符 {DELIMITER_LABEL[view.delimiter] ?? view.delimiter}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {view.more ? `仅显示前 ${view.body.length} 行` : eof ? '已读完' : '读取中…'}
        </span>
      </div>
      <div ref={scrollportRef} style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--dsw-font-family)', fontSize: 12, whiteSpace: 'nowrap' }}>
          <thead>
            <tr>
              <th style={cornerStyle} />
              {view.header.map((value, column) => (
                <th key={column} style={headerStyle}>{value || `列 ${column + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.body.map((row, index) => (
              <tr key={index}>
                <td style={indexStyle}>{index + 1}</td>
                {row.map((value, column) => (
                  <td key={column} style={cellStyle}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view.more && (
        <div style={{ flex: '0 0 auto', padding: '6px 12px', borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
          <button
            type="button"
            onClick={() => setLimit(current => current + PAGE_ROWS)}
            style={{
              font: 'inherit', fontSize: 12, cursor: 'pointer', padding: '2px 10px', borderRadius: 6,
              color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-l2)',
            }}
          >
            再加载 {PAGE_ROWS} 行
          </button>
        </div>
      )}
    </div>
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

const indexStyle = {
  padding: '3px 10px',
  textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  position: 'sticky' as const,
  left: 0,
  background: 'var(--dsw-alias-bg-base)',
  userSelect: 'none' as const,
}

const cellStyle = {
  padding: '3px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
}
