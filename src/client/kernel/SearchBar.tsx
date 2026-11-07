/** The shared search field: query, toggles, match navigation, optional filtering. */
import { useRef } from 'react'
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
  /**
   * Enter key. Previews that need an explicit step (a whole-file scan, say) take it over;
   * without it Enter is just "next".
   */
  readonly onSubmit?: () => void
  /** Whether non-matching rows are hidden. */
  readonly filter: boolean
  /** Toggle filtering. */
  readonly onFilter: (next: boolean) => void
  /**
   * Whether the caller can filter at all. A windowed table holds only one screen of
   * rows, so hiding the rest is not something it can do honestly.
   */
  readonly filterable?: boolean
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
  options, onChange, matches, index, onPrev, onNext, onSubmit, filter, onFilter,
  filterable = true, placeholder, children, compact = false,
}: SearchBarProps) {
  useLocale()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const active = options.query.trim() !== ''
  const clear = (): void => {
    onChange({ ...options, query: '' })
    inputRef.current?.focus()
  }
  // Enter walks the matches the way an editor does; Esc clears and drops focus. A preview
  // that scans on demand gets the Enter first, so typing stays cheap.
  const onKeyDown = (event: any): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrev()
      else if (onSubmit !== undefined) onSubmit()
      else onNext()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onChange({ ...options, query: '' })
      event.currentTarget.blur()
    }
  }
  return (
    <>
      <style>{SEARCH_CSS}</style>
      <div style={compact ? compactRow : rowStyle}>
        {/* The field owns its toggles, like an editor's find box: they read as part
            of the input instead of competing with it for bar width. Host search fields
            put the focus colour on the border, not on an extra box-shadow ring. */}
        <div className="dsh-preview-search" style={fieldStyle}>
          <input
            ref={inputRef}
            type="search"
            value={options.query}
            onChange={event => onChange({ ...options, query: event.target.value })}
            placeholder={placeholder ?? t('search.placeholder')}
            aria-label={t('search.aria')}
            onKeyDown={onKeyDown}
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
          {options.query !== '' && (
            <button
              type="button"
              className="dsh-preview-control"
              title={t('search.clear')}
              aria-label={t('search.clear')}
              onClick={clear}
              style={clearStyle}
            >
              ×
            </button>
          )}
        </div>
        <button type="button" className="dsh-preview-control" title={t('search.prev')} onClick={onPrev} disabled={matches === 0} style={navStyle}>↑</button>
        <button type="button" className="dsh-preview-control" title={t('search.next')} onClick={onNext} disabled={matches === 0} style={navStyle}>↓</button>
        {!compact && (
          <>
            {active && <span style={countStyle}>{`${index + 1}/${matches}`}</span>}
            {filterable && (
              <label style={labelStyle}>
                <input type="checkbox" checked={filter} onChange={event => onFilter(event.target.checked)} />
                {t('search.onlyMatches')}
              </label>
            )}
          </>
        )}
        {children}
      </div>
    </>
  )
}

// The compact row must be able to shrink: `minWidth: 0` on both the row and the
// field is what lets it fit a bar that is only ~300px wide.
const compactRow = {
  display: 'flex', alignItems: 'center', gap: 4, flex: '1 1 auto', minWidth: 0,
} as const

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto',
} as const

const fieldStyle = {
  display: 'flex', alignItems: 'center', gap: 2, flex: '1 1 auto', minWidth: 0,
  padding: '0 2px 0 8px', height: 28,
} as const

/** Host search-field language: hairline l3, focus colour on the border. */
const SEARCH_CSS = `
.dsh-preview-search {
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
}
.dsh-preview-search:hover {
  border-color: var(--dsw-alias-border-l2);
}
.dsh-preview-search:focus-within {
  border-color: var(--dsw-alias-state-business-primary);
}
.dsh-preview-search input::placeholder {
  color: var(--dsw-alias-label-caption);
}
.dsh-preview-search input::-webkit-search-cancel-button {
  display: none;
}
`

const inputStyle = {
  font: 'inherit', fontSize: 12, lineHeight: '18px', padding: 0, flex: '1 1 auto', minWidth: 0,
  color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: 'none',
  outline: 'none',
} as const

function inlineToggle(on: boolean) {
  return {
    font: 'inherit', fontSize: 11, lineHeight: '16px', padding: '0 4px',
    borderRadius: 'var(--dsw-radius-xs)',
    cursor: 'pointer', height: 20, flex: '0 0 auto',
    color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    fontWeight: on ? 600 : 400,
    background: on ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
    border: 'none',
  } as const
}

const navStyle = {
  font: 'inherit', fontSize: 14, lineHeight: '18px', padding: '0 6px', borderRadius: 'var(--dsw-radius-sm)',
  cursor: 'pointer', height: 28, minWidth: 28, flex: '0 0 auto', border: 'none',
} as const

const clearStyle = {
  width: 20, height: 20, padding: 0, flex: '0 0 auto',
  fontSize: 14, lineHeight: '20px', borderRadius: 'var(--dsw-radius-xs)',
  border: 'none', cursor: 'pointer',
} as const

const countStyle = {
  color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px',
  whiteSpace: 'nowrap', minWidth: 48, textAlign: 'center',
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap',
} as const
