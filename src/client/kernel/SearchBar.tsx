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
}

export function SearchBar({
  options, onChange, matches, index, total, onPrev, onNext, filter, onFilter,
  placeholder, children,
}: SearchBarProps) {
  useLocale()
  const active = options.query.trim() !== ''
  return (
    <div style={rowStyle}>
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
        style={toggleStyle(options.caseSensitive)}
      >
        Aa
      </button>
      <button
        type="button"
        title={t('search.regex')}
        aria-pressed={options.regex}
        onClick={() => onChange({ ...options, regex: !options.regex })}
        style={toggleStyle(options.regex)}
      >
        .*
      </button>
      <span style={countStyle}>
        {active ? `${index + 1}/${matches}` : t('search.lines', { count: total.toLocaleString('en-US') })}
      </span>
      <button type="button" title={t('search.prev')} onClick={onPrev} disabled={matches === 0} style={navStyle}>↑</button>
      <button type="button" title={t('search.next')} onClick={onNext} disabled={matches === 0} style={navStyle}>↓</button>
      <label style={labelStyle}>
        <input type="checkbox" checked={filter} onChange={event => onFilter(event.target.checked)} />
        {t('search.onlyMatches')}
      </label>
      {children}
    </div>
  )
}

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
} as const

const inputStyle = {
  font: 'inherit', fontSize: 12, padding: '2px 8px', width: 150, borderRadius: 6,
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

function toggleStyle(on: boolean) {
  return {
    font: 'inherit', fontSize: 11, lineHeight: '18px', padding: '0 5px', borderRadius: 4,
    cursor: 'pointer', height: 22,
    color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
    border: `1px solid ${on ? 'var(--dsw-alias-border-l3)' : 'var(--dsw-alias-border-l2)'}`,
  } as const
}

const navStyle = {
  font: 'inherit', fontSize: 11, lineHeight: '18px', padding: '0 6px', borderRadius: 4,
  cursor: 'pointer', height: 22, color: 'var(--dsw-alias-label-secondary)',
  background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
} as const

const countStyle = {
  color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, whiteSpace: 'nowrap',
  minWidth: 48, textAlign: 'center',
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12, whiteSpace: 'nowrap',
} as const
