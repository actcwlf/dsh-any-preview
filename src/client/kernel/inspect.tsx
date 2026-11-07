/**
 * Shared presentation for the metadata inspectors (SafeTensors, GGUF, SQLite).
 *
 * These formats are not rendered as content: the body reads a bounded header
 * and shows what the file says about itself. The pieces below are all they need.
 */
import { useLocale } from '../useLocale.ts'
import { t } from '../i18n.ts'
import type { ReactNode } from 'react'
import { TEXT } from './ui.ts'

/** One summary fact shown above the content. */
export interface InspectField {
  readonly label: string
  readonly value: string
}

/** Wrapping row of label/value chips. */
export function Summary({ fields }: { readonly fields: readonly InspectField[] }): ReactNode {
  const visible = fields.filter(field => field.value !== '')
  if (visible.length === 0) return null
  return (
    <div style={summaryStyle}>
      {visible.map(field => (
        <span key={field.label} style={chipStyle}>
          <span style={chipLabelStyle}>{field.label}</span>
          <span style={chipValueStyle}>{field.value}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * A dense table; columns listed in `right` are right-aligned (numbers).
 * @param columns - header labels.
 * @param rows - cell text, already formatted.
 */
export function DataTable({ columns, rows, right = [] }: {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly right?: readonly number[]
}): ReactNode {
  const align = (index: number): 'left' | 'right' => right.includes(index) ? 'right' : 'left'
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={column} style={{ ...thStyle, textAlign: align(index) }}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={{ ...tdStyle, textAlign: align(cellIndex) }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Muted explanatory line. */
export function Note({ children }: { readonly children: ReactNode }): ReactNode {
  return <div style={noteStyle}>{children}</div>
}

/** Key/value table for metadata dictionaries. */
export function KeyValueTable({ entries }: { readonly entries: readonly (readonly [string, string])[] }): ReactNode {
  useLocale()
  if (entries.length === 0) return null
  return <DataTable columns={[t('common.key'), t('common.value')]} rows={entries.map(entry => [entry[0], entry[1]])} />
}

const summaryStyle = {
  display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center',
  gap: 6, margin: '0 0 10px',
} as const

const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 5, flex: '0 0 auto',
  height: 20, padding: '0 8px', borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2)',
  fontSize: TEXT.caption.fontSize, lineHeight: TEXT.caption.lineHeight,
} as const

const chipLabelStyle = { color: 'var(--dsw-alias-label-tertiary)' } as const
const chipValueStyle = { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } as const

const tableStyle = {
  borderCollapse: 'collapse' as const, width: '100%',
  fontSize: TEXT.table.fontSize, lineHeight: TEXT.table.lineHeight,
} as const
const thStyle = {
  position: 'sticky' as const, top: 0, padding: '4px 10px', fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap' as const,
  lineHeight: TEXT.table.lineHeight,
} as const
const tdStyle = {
  padding: '3px 10px', color: 'var(--dsw-alias-label-primary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap' as const,
  lineHeight: TEXT.table.lineHeight,
} as const

const noteStyle = {
  padding: '8px 16px', fontSize: TEXT.caption.fontSize,
  lineHeight: TEXT.caption.lineHeight, color: 'var(--dsw-alias-label-tertiary)',
} as const
