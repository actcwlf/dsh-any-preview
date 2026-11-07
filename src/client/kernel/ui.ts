/**
 * Shared preview UI measurements and typography.
 *
 * The host document header is 38px; the preview's own utility bar is a
 * secondary 32px row below it, so the two never compete for the same visual
 * weight. Every format uses the same measurements so changing format does not
 * move the content or change the size of a button. Values are intentionally
 * constants rather than a themeable API: this is one product surface, not a
 * component kit.
 */

/** Canonical host font families, with safe fallbacks for tests. */
export const FONT_SANS = 'var(--dsw-font-family, inherit)'
export const FONT_MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** Standard chrome metrics. */
export const CHROME = {
  /** Secondary toolbar below DSH's 38px document header. */
  height: 32,
  /** One button/input target inside a bar. */
  control: 28,
  /** Bottom status line. */
  status: 28,
  /** Horizontal inset, host-style: more room before the title than after the tools. */
  padding: '0 12px 0 16px',
  gap: 8,
  /** Host header separator; the body uses the lighter l2 border. */
  border: '0.5px solid var(--dsw-alias-border-l3)',
} as const

/** Typography roles. */
export const TEXT = {
  chrome: { fontSize: 13, lineHeight: '20px' },
  meta: { fontSize: 12, lineHeight: '16px' },
  table: { fontSize: 12, lineHeight: '18px' },
  code: { fontSize: 12, lineHeight: '18px' },
  caption: { fontSize: 11, lineHeight: '16px' },
} as const

/** Shared bar and status styles used by `PreviewChrome` and custom panes. */
export const CHROME_BAR = {
  boxSizing: 'border-box' as const,
  display: 'flex',
  alignItems: 'center',
  gap: CHROME.gap,
  height: CHROME.height,
  flex: '0 0 auto',
  minWidth: 0,
  padding: CHROME.padding,
  borderBottom: CHROME.border,
  fontFamily: FONT_SANS,
  fontSize: TEXT.chrome.fontSize,
  lineHeight: TEXT.chrome.lineHeight,
  color: 'var(--dsw-alias-label-secondary)',
  overflow: 'visible',
} as const

/** Title/leading slot: one line, yields before the toolbar. */
export const CHROME_TITLE = {
  minWidth: 0,
  flex: '0 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 500,
} as const

/** Trailing controls: fixed 28px targets, no wrapping. */
export const CHROME_TOOLBAR = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: CHROME.gap,
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'visible',
  whiteSpace: 'nowrap' as const,
} as const

/** Bottom status line. */
export const CHROME_STATUS = {
  boxSizing: 'border-box' as const,
  display: 'flex',
  alignItems: 'center',
  height: CHROME.status,
  flex: '0 0 auto',
  padding: '0 16px',
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  fontFamily: FONT_SANS,
  fontSize: TEXT.meta.fontSize,
  lineHeight: TEXT.meta.lineHeight,
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap' as const,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const

/** A 28px text/select control in a toolbar. */
export const CHROME_CONTROL = {
  boxSizing: 'border-box' as const,
  height: CHROME.control,
  minHeight: CHROME.control,
  padding: '0 10px',
  borderRadius: 'var(--dsw-radius-sm)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: TEXT.meta.fontSize,
  lineHeight: '18px',
  cursor: 'pointer',
} as const

/** Hover/focus/disabled states shared by text buttons and selects. */
export const PREVIEW_CONTROL_CSS = `
.dsh-preview-control:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-preview-control:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
}
.dsh-preview-control:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.dsh-preview-control:disabled {
  opacity: .45;
  cursor: default;
}
`
