/**
 * Glyphs and styles for the model toolbar.
 *
 * The product icon set has no fit/grid/wireframe/rotate glyphs, so these are
 * drawn to its conventions: 16 viewBox, 1px stroke, currentColor, rendered at
 * 15px inside the host's 28px tool button.
 */

/** Glyphs the model toolbar uses. */
export type ToolKind =
  | 'reset' | 'grid' | 'wireframe' | 'rotate'
  | 'theme' | 'light' | 'dark'
  | 'play' | 'pause'

/**
 * One line icon.
 * @param kind - which glyph to draw.
 * @returns the icon element.
 */
export function ToolIcon({ kind }: { readonly kind: ToolKind }) {
  return (
    <svg
      viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {kind === 'reset' && (
        <>
          <path d="M2.5 5.5V3.5a1 1 0 0 1 1-1h2" />
          <path d="M10.5 2.5h2a1 1 0 0 1 1 1v2" />
          <path d="M13.5 10.5v2a1 1 0 0 1-1 1h-2" />
          <path d="M5.5 13.5h-2a1 1 0 0 1-1-1v-2" />
          <circle cx="8" cy="8" r="1.1" />
        </>
      )}
      {kind === 'grid' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
          <path d="M6.17 2.5v11M9.83 2.5v11M2.5 6.17h11M2.5 9.83h11" />
        </>
      )}
      {kind === 'wireframe' && (
        <>
          <path d="M8 1.9 13.5 5v6L8 14.1 2.5 11V5L8 1.9Z" />
          <path d="M2.5 5 8 8.1 13.5 5M8 8.1v6" />
        </>
      )}
      {kind === 'rotate' && (
        // Two arrows, not the single circular arrow the document header uses
        // for reload: a loop reads as continuous motion, and at 15px the two
        // arrowheads keep it distinct from the refresh glyph beside it.
        <>
          <path d="M12.8 8.2a4.9 4.9 0 0 1-8.4 3.4" />
          <path d="M4.4 13.8v-2.7h2.7" />
          <path d="M3.2 7.8a4.9 4.9 0 0 1 8.4-3.4" />
          <path d="M11.6 2.2v2.7H8.9" />
        </>
      )}
      {kind === 'theme' && (
        <>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 2.5a5.5 5.5 0 0 0 0 11Z" fill="currentColor" stroke="none" />
        </>
      )}
      {kind === 'light' && (
        <>
          <circle cx="8" cy="8" r="2.6" />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8" />
          <path d="m3.4 3.4 1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
        </>
      )}
      {kind === 'dark' && (
        <path d="M12.8 9.4A5.2 5.2 0 0 1 6.6 3.2a5.2 5.2 0 1 0 6.2 6.2Z" />
      )}
      {kind === 'play' && (
        <path d="M5.2 3.1 13 8l-7.8 4.9V3.1Z" fill="currentColor" stroke="none" />
      )}
      {kind === 'pause' && (
        <>
          <rect x="4.6" y="3.1" width="2.3" height="9.8" rx="0.4" fill="currentColor" stroke="none" />
          <rect x="9.1" y="3.1" width="2.3" height="9.8" rx="0.4" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

/**
 * The same control as the host's document toolbar: a 28px transparent square
 * around a 15px glyph, radius-sm, hover/active on the shared interactive
 * tokens. Inline styles cannot express hover/focus/disabled, hence the sheet.
 */
export const TOOL_CSS = `
.dsh-model-tool {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  color: var(--dsw-alias-label-secondary);
  line-height: 1;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dsh-model-tool svg {
  width: 15px;
  height: 15px;
}
.dsh-model-tool:hover:not(:disabled),
.dsh-model-tool[aria-pressed="true"]:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-model-tool:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
}
.dsh-model-tool:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dsh-model-tool:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
`
