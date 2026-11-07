/**
 * The model pane's loading and failure overlay.
 *
 * The layer is transparent on purpose: the canvas (or the pane surface, before
 * it exists) is already the themed background its text was designed for.
 */
import { t } from '../../i18n.ts'
import { PANE_FILL } from '../../kernel/layout.ts'

/** Props for the overlay. */
export interface ModelOverlayProps {
  /** Current viewer status; `ready` renders nothing. */
  readonly status: 'loading' | 'ready' | 'error'
  /** Localized failure text for the error state. */
  readonly detail: string
  /** Whether a retry could change the outcome. */
  readonly retryable: boolean
  /** Localized loading line, including byte progress when known. */
  readonly loadingText: string
  /** Start a fresh load. */
  readonly onRetry: () => void
}

/**
 * Render the loading or failure layer.
 * @param props - status, copy, and the retry callback.
 * @returns the overlay, or null while the viewer is ready.
 */
export function ModelOverlay({ status, detail, retryable, loadingText, onRetry }: ModelOverlayProps) {
  if (status === 'ready') return null
  return (
    <div style={{ ...PANE_FILL, background: 'transparent' }}>
      {status === 'loading'
        ? <span>{loadingText}</span>
        : (
          <div style={failureStyle} data-model-failure={detail}>
            <span style={failureTextStyle}>{t('common.error', { detail })}</span>
            {retryable && (
              <button type="button" style={retryStyle} onClick={onRetry}>
                {t('model.retry')}
              </button>
            )}
          </div>
        )}
    </div>
  )
}

const failureStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
  maxWidth: 360, padding: 16,
} as const

const failureTextStyle = { textAlign: 'center', lineHeight: 1.5 } as const

const retryStyle = {
  height: 28, padding: '0 12px', fontSize: 12, borderRadius: 'var(--dsw-radius-sm)',
  border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent',
  color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
} as const
