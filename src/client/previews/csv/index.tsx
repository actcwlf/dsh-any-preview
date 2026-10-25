/** Streaming CSV/TSV table with windowed rows over the incremental pipeline. */
import { useEffect, useRef, useState } from 'react'
import { previewSourceOf } from '../../kernel/source.ts'
import { createRowBuffer } from '../../kernel/text-pipeline.ts'
import type { RowBuffer } from '../../kernel/text-pipeline.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { DELIMITER_LABEL, detectDelimiter } from './detect.ts'

/** Row budget: beyond this the view stops accumulating and says so. */
const MAX_ROWS = 20_000

/** Fixed row height the windowing math relies on. */
const ROW_HEIGHT = 22

/** Rows rendered above and below the viewport to cover fast scrolling. */
const OVERSCAN = 8

/** Viewport height before the first measurement. */
const FALLBACK_VIEWPORT = 480

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

export function CsvBody({ content, scrollportRef }: PreviewBodyProps) {
  const source = previewSourceOf(content)
  const text = source.kind === 'text' ? source.text : ''
  const eof = source.kind === 'text' ? source.eof : false

  const bufferRef = useRef<RowBuffer | null>(null)
  const delimiterRef = useRef<string>(',')
  const consumedRef = useRef(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT)

  // Consume during render: parsing is a pure fold over the new suffix, and the
  // `consumed` cursor makes a repeated render (StrictMode) a no-op. Doing this
  // in an effect would show an empty first frame and break server rendering.
  if (source.kind === 'text' && bufferRef.current === null && text.length > 0) {
    delimiterRef.current = detectDelimiter(text)
    bufferRef.current = createRowBuffer(delimiterRef.current, MAX_ROWS)
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

  const ready = buffer !== null
  useEffect(() => {
    if (!ready) return
    const element = scrollerRef.current
    if (element === null) return
    const measure = (): void => { setViewportHeight(element.clientHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ready])

  if (buffer === null) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
        正在读取…
      </div>
    )
  }

  const rows = buffer.rows
  const header = rows[0] ?? []
  const body = rows.slice(1)
  const { cells, columns } = normalize([header, ...body])
  const headerCells = cells[0] ?? []
  const bodyCells = cells.slice(1)

  // Only the rows the viewport can show are mounted; spacers keep the scrollbar
  // honest for the rest.
  const total = bodyCells.length
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const windowRows = bodyCells.slice(first, last)

  const status = buffer.truncated
    ? `已截断（上限 ${MAX_ROWS.toLocaleString('en-US')} 行）`
    : buffer.complete ? '已读完' : '读取中…'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
      }}>
        <span>
          {total.toLocaleString('en-US')} 行 × {columns} 列
          {' · '}分隔符 {DELIMITER_LABEL[delimiterRef.current] ?? delimiterRef.current}
        </span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{status}</span>
      </div>
      <div
        ref={(element) => {
          scrollerRef.current = element
          scrollportRef?.(element)
        }}
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        style={{ flex: '1 1 auto', overflow: 'auto' }}
      >
        <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--dsw-font-family)', fontSize: 12, whiteSpace: 'nowrap' }}>
          <thead>
            <tr>
              <th style={cornerStyle} />
              {headerCells.map((value, column) => (
                <th key={column} style={headerStyle}>{value || `列 ${column + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && (
              <tr style={{ height: first * ROW_HEIGHT }}>
                <td colSpan={columns + 1} style={spacerCell} />
              </tr>
            )}
            {windowRows.map((row, offset) => {
              const index = first + offset
              return (
                <tr key={index} style={{ height: ROW_HEIGHT }}>
                  <td style={indexStyle}>{index + 1}</td>
                  {row.map((value, column) => (
                    <td key={column} style={cellStyle}>{value}</td>
                  ))}
                </tr>
              )
            })}
            {last < total && (
              <tr style={{ height: (total - last) * ROW_HEIGHT }}>
                <td colSpan={columns + 1} style={spacerCell} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

const spacerCell = { padding: 0, border: 'none' } as const

const indexStyle = {
  padding: '0 10px',
  lineHeight: `${String(ROW_HEIGHT - 2)}px`,
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
  lineHeight: `${String(ROW_HEIGHT - 2)}px`,
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-label-primary)',
}

/** What the client entry registers for this format. */
export const csvPreview: PreviewModule = {
  id: 'dsh-any-preview/csv',
  extensions: ['csv', 'tsv'],
  load: 'text-pages',
  wrap: false,
  title: () => 'CSV 表格',
  Body: CsvBody,
}
