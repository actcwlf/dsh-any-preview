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
  /** Secondary summary shown after the primary label, e.g. a format summary. */
  readonly meta?: ReactNode
}

export function PreviewTitle({ kind, children, meta }: PreviewTitleProps) {
  return (
    <span style={rootStyle}>
      {kind !== undefined && kind !== '' && <span style={kindStyle}>{kind}</span>}
      <span style={labelStyle}>
        <span style={primaryStyle}>{children}</span>
        {meta !== undefined && <span style={metaStyle}> · {meta}</span>}
      </span>
    </span>
  )
}

const rootStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  minWidth: 0, maxWidth: '100%',
} as const

const kindStyle = {
  flex: '0 0 auto', padding: '0 5px', borderRadius: 'var(--dsw-radius-xs)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: TEXT.caption.fontSize, lineHeight: TEXT.caption.lineHeight, fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase' as const,
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'baseline',
  minWidth: 0, flex: '0 1 auto',
} as const

const primaryStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const, flex: '1 1 auto',
  fontSize: TEXT.chrome.fontSize, lineHeight: TEXT.chrome.lineHeight, fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
} as const

const metaStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const, flex: '0 1 auto',
  fontSize: TEXT.meta.fontSize, lineHeight: TEXT.meta.lineHeight, fontWeight: 400,
  color: 'var(--dsw-alias-label-tertiary)',
} as const
