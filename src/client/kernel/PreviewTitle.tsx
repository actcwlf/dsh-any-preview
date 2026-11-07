/**
 * One consistent leading label for every preview bar.
 *
 * A short type badge identifies the format; the primary slot carries the file
 * name or content summary at the same 13/20 weight everywhere. Keeping both in
 * one component is what prevents CSV, a log and a 3D model from drifting into
 * "some bold, some not, some with a type, some without".
 *
 * Badges are deliberate ASCII format identifiers (CSV/LOG/GGUF/EPUB…), not
 * translated prose; the localized surface lives in the primary label.
 */
import type { ReactNode } from 'react'
import { TEXT } from './ui.ts'

/** Props for the leading label. */
export interface PreviewTitleProps {
  /** Short format label, e.g. CSV, LOG, EPUB. */
  readonly kind?: string
  /** File name or one-line content summary. */
  readonly children: ReactNode
}

export function PreviewTitle({ kind, children }: PreviewTitleProps) {
  return (
    <span style={rootStyle}>
      {kind !== undefined && kind !== '' && <span style={kindStyle}>{kind}</span>}
      <span style={primaryStyle}>{children}</span>
    </span>
  )
}

const rootStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  minWidth: 0, maxWidth: '100%',
} as const

const kindStyle = {
  flex: '0 0 auto', padding: '0 5px', borderRadius: 4,
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: TEXT.caption.fontSize, lineHeight: TEXT.caption.lineHeight, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase' as const,
} as const

const primaryStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  fontSize: TEXT.chrome.fontSize, lineHeight: TEXT.chrome.lineHeight, fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
} as const
