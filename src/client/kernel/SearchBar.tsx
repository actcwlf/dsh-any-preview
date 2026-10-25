/** The shared search field every text preview puts in its header bar. */
import type { ReactNode } from 'react'

/** Props for one preview's search field. */
export interface SearchBarProps {
  /** Current query text. */
  readonly value: string
  /** Called with the new query on every keystroke. */
  readonly onChange: (next: string) => void
  /** Rows matching the query. */
  readonly matches: number
  /** Rows in the model, before filtering. */
  readonly total: number
  /** Placeholder copy. */
  readonly placeholder?: string
  /** Trailing content, e.g. a follow-tail toggle. */
  readonly children?: ReactNode
}

export function SearchBar({ value, onChange, matches, total, placeholder = '搜索…', children }: SearchBarProps) {
  return (
    <div style={rowStyle}>
      <input
        type="search"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="在当前文件中搜索"
        style={inputStyle}
      />
      <span style={countStyle}>
        {value.trim() === ''
          ? `${total.toLocaleString('en-US')} 行`
          : `${matches.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} 行`}
      </span>
      {children}
    </div>
  )
}

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flex: '0 0 auto',
} as const

const inputStyle = {
  font: 'inherit',
  fontSize: 12,
  padding: '2px 8px',
  width: 180,
  borderRadius: 6,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

const countStyle = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  whiteSpace: 'nowrap',
} as const
