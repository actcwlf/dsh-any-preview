/**
 * The shared shell every preview sits in.
 *
 * Four optional regions and nothing else: a title, a toolbar, the body, and a
 * one-line status. The point is not flexibility — it is that a reader sees the
 * same chrome, in the same place, whatever format they opened, and that adding
 * a capability (a keyboard shortcut, a status line) touches one file.
 *
 * Deliberately not configurable beyond this: anything that needs a different
 * shape is a preview with a different shape, not a parameter.
 */
import type { ReactNode } from 'react'

/** One preview's chrome. */
export interface PreviewChromeProps {
  /** Name, size and format hint; omitted when the preview shows its own header. */
  readonly title?: ReactNode
  /** Search, filters and view switches. */
  readonly toolbar?: ReactNode
  /** One line at the bottom: row budget, truncation, errors. */
  readonly status?: ReactNode
  /** Colours the status line; `critical` for failures. */
  readonly tone?: 'normal' | 'critical'
  readonly children: ReactNode
}

const BAR = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 12px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  flex: '0 0 auto',
} as const

const STATUS = {
  padding: '4px 12px',
  fontSize: 12,
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  flex: '0 0 auto',
} as const

/**
 * Wrap a preview body in the shared chrome.
 * @param props - title, toolbar, status and the body.
 * @returns the framed preview.
 */
export function PreviewChrome({ title, toolbar, status, tone = 'normal', children }: PreviewChromeProps) {
  const hasBar = title !== undefined || toolbar !== undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {hasBar && (
        <div style={BAR}>
          {title !== undefined && <span>{title}</span>}
          <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, minWidth: 0 }}>
            {toolbar}
          </div>
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
      {status !== undefined && status !== '' && (
        <div style={{ ...STATUS, color: tone === 'critical' ? 'var(--dsw-alias-label-error, #c0392b)' : 'var(--dsw-alias-label-tertiary)' }}>
          {status}
        </div>
      )}
    </div>
  )
}
