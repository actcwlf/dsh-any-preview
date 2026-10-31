/**
 * The archive listing, shared by every container format.
 *
 * Containers supply data and three callbacks; the bar, the hints and the table are
 * the same everywhere, so zip and 7z cannot drift apart again.
 */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { formatBytes } from '../../kernel/format.ts'
import { t } from '../../i18n.ts'
import type { EntryLike } from './EntryView.tsx'

/** Everything a container hands the listing. */
export interface ArchiveListProps {
  readonly entries: readonly EntryLike[]
  readonly summary: string
  /** Result of the last action (re-extract, clean); shown in the bar. */
  readonly notice?: string
  readonly lastEntry?: EntryLike
  readonly onSelect: (entry: EntryLike) => void
  readonly onReextract?: () => void
  readonly onClean?: () => void
}

export function ArchiveList(props: ArchiveListProps) {
  const { entries, summary, notice, lastEntry, onSelect, onReextract, onClean } = props

  return (
    <PreviewChrome>
      <div style={BAR}>
        <span>{summary}</span>
        <span style={ACTIONS}>
          <span>{notice ?? t('archive.hint')}</span>
          {lastEntry !== undefined && onReextract !== undefined && (
            <button type="button" onClick={onReextract} style={SMALL}>
              {t('archive.reextract', { name: lastEntry.name })}
            </button>
          )}
          {onClean !== undefined && (
            <button type="button" onClick={onClean} style={SMALL}>{t('archive.clean')}</button>
          )}
        </span>
      </div>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={HEADER}>{t('common.name')}</th>
              <th style={{ ...HEADER, textAlign: 'right', width: 90 }}>{t('common.size')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr
                key={`${String(index)}:${entry.name}`}
                onClick={entry.directory ? undefined : () => onSelect(entry)}
                style={{ cursor: entry.directory ? 'default' : 'pointer' }}
              >
                <td style={{ ...CELL, color: entry.directory ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' }}>
                  {entry.name}
                </td>
                <td style={{ ...CELL, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {entry.directory ? '' : formatBytes(entry.size)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PreviewChrome>
  )
}

const BAR = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto', minWidth: 0,
} as const
const ACTIONS = {
  display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-tertiary)',
  flex: '0 1 auto', minWidth: 0, overflow: 'hidden',
} as const
const SMALL = {
  font: 'inherit', fontSize: 12, padding: '2px 10px', borderRadius: 6, cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const
const TABLE = {
  borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--dsw-font-family)', fontSize: 12,
} as const
const HEADER = {
  position: 'sticky' as const, top: 0, padding: '5px 12px', textAlign: 'left' as const, fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
} as const
const CELL = {
  padding: '4px 12px', fontFamily: 'var(--dsw-font-family)', fontSize: 12,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
} as const
