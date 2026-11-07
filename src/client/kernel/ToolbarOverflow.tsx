/**
 * A compact `⋯` control for toolbars that cannot fit every action.
 *
 * The bar keeps its 32px height; only the controls move into this panel. That is
 * preferable to wrapping the bar or hiding tools behind `overflow: hidden`.
 */
import type { ReactNode } from 'react'
import { t } from '../i18n.ts'
import { CHROME_CONTROL } from './ui.ts'
import { PreviewMenu } from './PreviewMenu.tsx'

/** Props for the overflow button/panel. */
export interface ToolbarOverflowProps {
  readonly label?: string
  readonly children: ReactNode
}

export function ToolbarOverflow({ label, children }: ToolbarOverflowProps) {
  const title = label ?? t('common.more')
  return (
    <PreviewMenu
      label={title}
      trigger={({ open: _open, ...triggerProps }) => (
        <button
          {...triggerProps}
          type="button"
          className="dsh-preview-control"
          style={triggerStyle}
          title={title}
          data-preview-overflow="true"
        >
          ⋯
        </button>
      )}
    >
      {children}
    </PreviewMenu>
  )
}

const triggerStyle = {
  ...CHROME_CONTROL,
  width: 28,
  padding: 0,
  fontSize: 16,
  lineHeight: '28px',
  textAlign: 'center' as const,
  flex: '0 0 auto',
} as const
