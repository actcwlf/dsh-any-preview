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
import { PreviewTitle } from './PreviewTitle.tsx'
import {
  CHROME_BAR,
  CHROME_STATUS,
  CHROME_TITLE,
  CHROME_TOOLBAR,
  FONT_SANS,
  PREVIEW_CONTROL_CSS,
} from './ui.ts'

/** One preview's chrome. */
export interface PreviewChromeProps {
  /** Short format label shown before the title, e.g. CSV, LOG, EPUB. */
  readonly kind?: string
  /** Name, size and format hint; every preview supplies at least a format summary. */
  readonly title?: ReactNode
  /** Search, filters and view switches; a function receives the compact flag. */
  readonly toolbar?: ReactNode | ((compact: boolean) => ReactNode)
  /** One line at the bottom for a caveat or failure; normal status is not rendered. */
  readonly status?: ReactNode
  /** Colours the status line; only `warning` and `critical` make it visible. */
  readonly tone?: 'normal' | 'warning' | 'critical'
  readonly children: ReactNode
}

/**
 * One threshold for every concession: below it the title goes and the toolbar
 * switches to its compact form. Two separate numbers produced a middle state
 * where the title had already left but the toolbar had not yet simplified —
 * change without visible benefit.
 */
const COMPACT_WIDTH = 420

export function PreviewChrome({ kind, title, toolbar, status, tone = 'normal', children }: PreviewChromeProps) {
  const { ref, width } = useElementWidth<HTMLDivElement>()
  // At the sidebar's minimum width there is no room for a label and a control in
  // one line; the label is the one that can go, because the document tab already
  // shows the file name. A title-only preview keeps its label: dropping it would
  // leave an empty 32px bar.
  const showTitle = title !== undefined
    && (toolbar !== undefined || width === 0 || width >= COMPACT_WIDTH)
  const compact = width > 0 && width < COMPACT_WIDTH
  const hasBar = showTitle || toolbar !== undefined
  return (
    // PANE_ROOT pins the shell to the owner's content box. A percentage height
    // does not: the owner's .body can itself be the scroller, and then the whole
    // chrome scrolls out of view with the content.
    <div
      ref={ref}
      style={{
        ...PANE_ROOT,
        fontFamily: FONT_SANS,
        fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      }}
      data-chrome-width={String(width)}
      data-chrome-compact={compact ? '1' : '0'}
    >
      <style>{PREVIEW_CONTROL_CSS}</style>
      {hasBar && (
        <div style={CHROME_BAR} data-preview-chrome="bar">
          {showTitle && (
            <span style={CHROME_TITLE}>
              <PreviewTitle kind={kind}>{title}</PreviewTitle>
            </span>
          )}
          {toolbar !== undefined && (
            <div style={CHROME_TOOLBAR}>
              {typeof toolbar === 'function' ? toolbar(compact) : toolbar}
            </div>
          )}
        </div>
      )}
      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>
      {status !== undefined && status !== '' && tone !== 'normal' && (
        <div
          style={{
            ...CHROME_STATUS,
            color: tone === 'critical'
              ? 'var(--dsw-alias-state-error-primary)'
              : tone === 'warning'
                ? 'var(--dsw-alias-state-warn-primary)'
                : 'var(--dsw-alias-label-tertiary)',
          }}
        >
          {status}
        </div>
      )}
    </div>
  )
}
