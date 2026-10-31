/** Line-delimited JSON viewer: one row per record, bad lines shown as raw text. */
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { ACTIVE_ROW, DOCUMENT_BODY, PANE_FILL } from '../../kernel/layout.ts'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { scrollToRow } from '../../kernel/scroll.ts'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { useSearch } from '../../kernel/useSearch.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { collectColumns, createJsonlConsumer, formatValue } from './parse.ts'

/** Rows rendered at once; the rest are counted, not mounted. */
const DISPLAY_ROWS = 2_000

export function JsonlBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
  const jsonl = useStreamedText(content, () => createJsonlConsumer())
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const records = jsonl?.records ?? []
  const texts = useMemo(() => records.map(record => record.raw), [records, records.length])
  const found = useSearch(texts, options)

  const visible = useMemo(() => {
    if (!filter || found.pattern === undefined) return records.map((record, index) => ({ record, index }))
    return found.matches.map(index => ({ record: records[index]!, index }))
  }, [records, records.length, filter, found.pattern, found.matches])

  useEffect(() => {
    if (found.activeRow === undefined) return
    scrollToRow(scroller.current, found.activeRow)
  }, [found.activeRow])

  if (jsonl === null) {
    return <div style={PANE_FILL}>{t('common.loading')}</div>
  }

  const columns = collectColumns(jsonl.records)
  const shown = visible.slice(0, DISPLAY_ROWS)
  const hidden = visible.length - shown.length
  const setScroller = (element: HTMLDivElement | null): void => {
    scroller.current = element
    scrollportRef?.(element)
  }

  return (
    <PreviewChrome
      title={(
        <span>
        <span>
          {t('jsonl.records', { count: jsonl.records.length.toLocaleString('en-US') })}
          {columns.length === 0 ? t('jsonl.nonObject') : t('jsonl.fields', { count: columns.length })}
          {jsonl.invalid > 0 && (
            <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{t('jsonl.invalid', { count: jsonl.invalid.toLocaleString('en-US') })}</span>
          )}
        </span>
        </span>
      )}
      toolbar={compact => (
        <SearchBar
          compact={compact}
          options={options}
          onChange={setOptions}
          matches={found.matches.length}
          index={found.index}
          total={jsonl.records.length}
          onPrev={found.prev}
          onNext={found.next}
          filter={filter}
          onFilter={setFilter}
        />
      )}
      status={jsonl.truncated
        ? t('common.truncated')
        : hidden > 0 ? t('jsonl.shown', { count: DISPLAY_ROWS.toLocaleString('en-US') }) : undefined}
    >
      <div ref={setScroller} style={{ ...DOCUMENT_BODY, flex: '1 1 auto', overflow: 'auto' }}>
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
            {shown.map(({ record, index }) => {
              const active = index === found.activeRow
              const rowStyle = {
                height: 22,
                background: active ? ACTIVE_ROW : record.error === undefined ? undefined : 'rgba(248, 81, 73, 0.14)',
                boxShadow: active ? 'inset 3px 0 0 var(--dsw-alias-state-warn-primary)' : undefined,
              } as const
              return record.error === undefined
                ? (
                    <tr key={index} data-row-index={index} style={rowStyle}>
                      <td style={indexStyle}>{record.line}</td>
                      {columns.map((column) => (
                        <td key={column} style={cellStyle}>
                          <Marked text={cellOf(record.value, column)} pattern={found.pattern} emphasis={active} />
                        </td>
                      ))}
                    </tr>
                  )
                : (
                    <tr key={index} data-row-index={index} style={rowStyle}>
                      <td style={indexStyle}>{record.line}</td>
                      <td colSpan={Math.max(1, columns.length)} style={{ ...cellStyle, color: 'var(--dsw-alias-state-error-primary)' }}>
                        <Marked text={record.raw} pattern={found.pattern} emphasis={active} />
                      </td>
                    </tr>
                  )
            })}
          </tbody>
        </table>
      </div>
    </PreviewChrome>
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
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const shared = {
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
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
  borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
  position: 'sticky' as const,
  left: 0,
  // Opaque and body-coloured: it slides under the header, so it cannot be transparent,
  // and a brighter surface would paint a strip down the pane.
  background: 'var(--dsw-alias-bg-document-preview)',
  userSelect: 'none' as const,
} as const

const cellStyle = {
  padding: '0 12px',
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