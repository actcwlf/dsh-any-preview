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
import { useElementWidth } from './useWidth.ts'
import { PANE_ROOT } from './layout.ts'

/** One preview's chrome. */
export interface PreviewChromeProps {
  /** Name, size and format hint; omitted when the preview shows its own header. */
  readonly title?: ReactNode
  /** Search, filters and view switches; a function receives the compact flag. */
  readonly toolbar?: ReactNode | ((compact: boolean) => ReactNode)
  /** One line at the bottom: row budget, truncation, errors. */
  readonly status?: ReactNode
  /** Colours the status line; `critical` for failures. */
  readonly tone?: 'normal' | 'critical'
  readonly children: ReactNode
}

// A narrow sidebar must not make the title and the toolbar overlap: the bar
// wraps instead, and the title yields space first.
const BAR = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'nowrap',
  gap: 8,
  rowGap: 6,
  padding: '6px 12px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  flex: '0 0 auto',
  minWidth: 0,
} as const

const TITLE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: '0 1 auto',
} as const

const TOOLBAR = {
  flex: '1 1 auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'nowrap',
  gap: 8,
  minWidth: 0,
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
/** Below this width the title yields its space to the toolbar. */
const TITLE_MIN_WIDTH = 340

/** Below this width the toolbar switches to its compact form. */
const TOOLBAR_COMPACT_WIDTH = 260

export function PreviewChrome({ title, toolbar, status, tone = 'normal', children }: PreviewChromeProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>()
  // At the sidebar's minimum width there is no room for a label and a control in
  // one line; the label is the one that can go, because the document tab already
  // shows the file name.
  const showTitle = title !== undefined && (width === 0 || width >= TITLE_MIN_WIDTH)
  const compact = width > 0 && width < TOOLBAR_COMPACT_WIDTH
  const hasBar = showTitle || toolbar !== undefined
  return (
    // PANE_ROOT pins the shell to the owner's content box. A percentage height
    // does not: the owner's .body can itself be the scroller, and then the whole
    // chrome scrolls out of view with the content.
    <div ref={ref} style={PANE_ROOT}>
      {hasBar && (
        <div style={BAR}>
          {showTitle && <span style={TITLE}>{title}</span>}
          <div style={TOOLBAR}>
            {typeof toolbar === 'function' ? toolbar(compact) : toolbar}
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
