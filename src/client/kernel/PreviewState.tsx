/**
 * A loading/error state that keeps the preview chrome in place.
 *
 * Returning a bare PANE_FILL removed the chrome until the file finished
 * parsing, so the body jumped downward on every open. This shell always renders
 * the type badge + title and only swaps the body for the message.
 */
import type { ReactNode } from 'react'
import { PreviewChrome } from './chrome.tsx'

/** Props for a chrome-preserving placeholder. */
export interface PreviewStateProps {
  readonly kind: string
  readonly title: ReactNode
  readonly message: ReactNode
  readonly tone?: 'normal' | 'critical'
}

export function PreviewState({ kind, title, message, tone = 'normal' }: PreviewStateProps) {
  return (
    <PreviewChrome kind={kind} title={title} tone={tone}>
      <div
        style={{
          ...fillStyle,
          color: tone === 'critical'
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-secondary)',
        }}
        role={tone === 'critical' ? 'alert' : 'status'}
      >
        {message}
      </div>
    </PreviewChrome>
  )
}

const fillStyle = {
  flex: '1 1 auto', minHeight: 0, display: 'grid', placeItems: 'center',
  padding: 16, textAlign: 'center' as const, whiteSpace: 'pre-wrap' as const,
} as const
