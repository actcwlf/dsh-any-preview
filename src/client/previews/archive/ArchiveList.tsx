/**
 * The archive listing, shared by every container format.
 *
 * Containers supply data and three callbacks; the bar, the hints and the table are
 * the same everywhere, so zip and 7z cannot drift apart again.
 */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { ToolbarOverflow } from '../../kernel/ToolbarOverflow.tsx'
import { CHROME_CONTROL, DATA_TABLE_HEADER } from '../../kernel/ui.ts'
import { formatBytes } from '../../kernel/format.ts'
import { t } from '../../i18n.ts'
import type { TransientNotice } from '../../kernel/useTransientNotice.ts'
import type { EntryLike } from './EntryView.tsx'

/** Backwards-compatible name for the shared transient notice shape. */
export type ArchiveNotice = TransientNotice

/** Everything a container hands the listing. */
export interface ArchiveListProps {
  readonly entries: readonly EntryLike[]
  readonly summary: string
  /** Result of the last action (re-extract, clean); shown as a transient toast. */
  readonly notice?: TransientNotice
  /** Persistent warning about the archive itself, not a just-finished action. */
  readonly status?: string
  readonly statusTone?: 'normal' | 'warning' | 'critical'
  readonly lastEntry?: EntryLike
  readonly onSelect: (entry: EntryLike) => void
  readonly onReextract?: () => void
  readonly onClean?: () => void
}

export function ArchiveList(props: ArchiveListProps) {
  const { entries, summary, notice, status, statusTone = 'warning', lastEntry, onSelect, onReextract, onClean } = props
  const hasActions = (lastEntry !== undefined && onReextract !== undefined) || onClean !== undefined
  const actions = (
    <>
      {lastEntry !== undefined && onReextract !== undefined && (
        <button type="button" onClick={onReextract} style={SMALL} className="dsh-preview-control">
          {t('archive.reextract', { name: lastEntry.name })}
        </button>
      )}
      {onClean !== undefined && (
        <button type="button" onClick={onClean} style={SMALL} className="dsh-preview-control">{t('archive.clean')}</button>
      )}
    </>
  )

  return (
    <PreviewChrome
      kind="ARCHIVE"
      title={summary}
      status={status}
      tone={statusTone}
      toolbar={!hasActions
        ? undefined
        : compact => (
          compact
            ? <ToolbarOverflow label={t('common.more')}>{actions}</ToolbarOverflow>
            : <span style={ACTIONS}>{actions}</span>
        )}
    >
      <style>{ARCHIVE_CSS}</style>
      <div style={BODY}>
        <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
          <table style={TABLE} title={t('archive.hint')}>
            <thead>
              <tr>
                <th style={HEADER}>{t('common.name')}</th>
                <th style={{ ...HEADER, textAlign: 'right', width: 90 }}>{t('common.size')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={2} style={EMPTY}>{t('archive.hint')}</td>
                </tr>
              )}
              {entries.map((entry, index) => (
                <tr
                  key={`${String(index)}:${entry.name}`}
                  className={entry.directory ? undefined : 'dsh-archive-row'}
                  data-archive-row={entry.directory ? 'directory' : 'file'}
                  tabIndex={entry.directory ? undefined : 0}
                  aria-label={entry.directory ? undefined : entry.name}
                  onClick={entry.directory ? undefined : () => onSelect(entry)}
                  onKeyDown={entry.directory
                    ? undefined
                    : event => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onSelect(entry)
                    }}
                  style={{ cursor: entry.directory ? 'default' : 'pointer' }}
                >
                  <td
                    style={{ ...CELL, color: entry.directory ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' }}
                    title={entry.name}
                  >
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
        {notice !== undefined && (
          <div
            style={{
              ...TOAST,
              color: notice.tone === 'critical'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)',
            }}
            role="status"
            data-archive-notice="true"
          >
            {notice.text}
          </div>
        )}
      </div>
    </PreviewChrome>
  )
}

const ARCHIVE_CSS = `
.dsh-archive-row:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-archive-row:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
`

const ACTIONS = {
  display: 'flex', alignItems: 'center', gap: 4, color: 'var(--dsw-alias-label-tertiary)',
  flex: '0 1 auto', minWidth: 0, overflow: 'hidden',
} as const
const SMALL = {
  ...CHROME_CONTROL,
  flex: '0 0 auto',
} as const
const BODY = {
  position: 'relative' as const,
  display: 'flex', flexDirection: 'column' as const,
  flex: '1 1 auto', minHeight: 0,
} as const
const TABLE = {
  borderCollapse: 'collapse' as const, tableLayout: 'fixed' as const, width: '100%',
  fontFamily: 'var(--dsw-font-family)', fontSize: 12, lineHeight: '18px',
} as const
const HEADER = {
  ...DATA_TABLE_HEADER,
  position: 'sticky' as const, top: 0,
  textAlign: 'left' as const, verticalAlign: 'middle' as const,
} as const
const CELL = {
  height: 28, padding: '0 16px', verticalAlign: 'middle' as const,
  fontFamily: 'var(--dsw-font-family)', fontSize: 12, lineHeight: '18px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
} as const
const EMPTY = {
  padding: '16px', textAlign: 'center' as const,
  fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
} as const
const TOAST = {
  position: 'absolute' as const, right: 12, bottom: 12, zIndex: 2,
  maxWidth: 'calc(100% - 24px)', padding: '6px 10px', pointerEvents: 'none' as const,
  borderRadius: 'var(--dsw-radius-sm)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12, lineHeight: '18px',
} as const
