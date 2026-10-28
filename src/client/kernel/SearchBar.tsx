/** The shared search field: query, toggles, match navigation, optional filtering. */
import { useLocale } from '../useLocale.ts'
import { t } from '../i18n.ts'
import type { ReactNode } from 'react'
import type { SearchOptions } from './search.ts'

/** Props for one preview's search field. */
export interface SearchBarProps {
  /** Current query and its modes. */
  readonly options: SearchOptions
  /** Replace the options (typing, toggles). */
  readonly onChange: (next: SearchOptions) => void
  /** Number of matching rows. */
  readonly matches: number
  /** Position within the matches; -1 when none. */
  readonly index: number
  /** Row count before filtering. */
  readonly total: number
  /** Move to the previous match. */
  readonly onPrev: () => void
  /** Move to the next match. */
  readonly onNext: () => void
  /** Whether non-matching rows are hidden. */
  readonly filter: boolean
  /** Toggle filtering. */
  readonly onFilter: (next: boolean) => void
  /** Placeholder copy. */
  readonly placeholder?: string
  /** Trailing content, e.g. a follow-tail toggle. */
  readonly children?: ReactNode
  /**
   * Trim the row to what fits a narrow sidebar: the field keeps the toggles but
   * drops the match counter and the filter label, which are what push a full row
   * to about 380px.
   */
  readonly compact?: boolean
}

export function SearchBar({
  options, onChange, matches, index, onPrev, onNext, filter, onFilter,
  placeholder, children, compact = false,
}: SearchBarProps) {
  useLocale()
  const active = options.query.trim() !== ''

  return (
    <div style={compact ? compactRow : rowStyle}>
      {/* The field owns its toggles, like an editor's find box: they read as part
          of the input instead of competing with it for bar width. */}
      <div style={fieldStyle}>
        <input
          type="search"
          value={options.query}
          onChange={event => onChange({ ...options, query: event.target.value })}
          placeholder={placeholder ?? t('search.placeholder')}
          aria-label={t('search.aria')}
          style={inputStyle}
        />
        <button
          type="button"
          title={t('search.case')}
          aria-pressed={options.caseSensitive}
          onClick={() => onChange({ ...options, caseSensitive: !options.caseSensitive })}
          style={inlineToggle(options.caseSensitive)}
        >
          Aa
        </button>
        <button
          type="button"
          title={t('search.regex')}
          aria-pressed={options.regex}
          onClick={() => onChange({ ...options, regex: !options.regex })}
          style={inlineToggle(options.regex)}
        >
          .*
        </button>
      </div>
      <button type="button" title={t('search.prev')} onClick={onPrev} disabled={matches === 0} style={navStyle}>↑</button>
      <button type="button" title={t('search.next')} onClick={onNext} disabled={matches === 0} style={navStyle}>↓</button>
      {!compact && (
        <>
          {active && <span style={countStyle}>{`${index + 1}/${matches}`}</span>}
          <label style={labelStyle}>
            <input type="checkbox" checked={filter} onChange={event => onFilter(event.target.checked)} />
            {t('search.onlyMatches')}
          </label>
        </>
      )}
      {children}
    </div>
  )
}

// The compact row must be able to shrink: `minWidth: 0` on both the row and the
// field is what lets it fit a bar that is only ~300px wide.
const compactRow = {
  display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 auto', minWidth: 0,
} as const

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
} as const

const fieldStyle = {
  display: 'flex', alignItems: 'center', gap: 2, flex: '1 1 auto', minWidth: 0,
  padding: '0 2px 0 8px', borderRadius: 6, height: 24,
  background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)',
} as const

const inputStyle = {
  font: 'inherit', fontSize: 12, padding: 0, flex: '1 1 auto', minWidth: 0,
  color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: 'none',
  outline: 'none',
} as const

function inlineToggle(on: boolean) {
  return {
    font: 'inherit', fontSize: 11, lineHeight: '16px', padding: '0 4px', borderRadius: 4,
    cursor: 'pointer', height: 18, flex: '0 0 auto',
    color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    background: on ? 'var(--dsw-alias-bg-base)' : 'transparent',
    border: `1px solid ${on ? 'var(--dsw-alias-border-l3)' : 'transparent'}`,
  } as const
}

const navStyle = {
  font: 'inherit', fontSize: 11, lineHeight: '18px', padding: '0 6px', borderRadius: 4,
  cursor: 'pointer', height: 22, color: 'var(--dsw-alias-label-secondary)',
  background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const countStyle = {
  color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, whiteSpace: 'nowrap',
  minWidth: 48, textAlign: 'center',
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12, whiteSpace: 'nowrap',
} as const
