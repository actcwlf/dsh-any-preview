/**
 * The model pane's view controls: reset, background, grid, wireframe,
 * auto-rotate.
 *
 * Presentation only: the viewer owns the settings and applies them. Buttons
 * follow the host document toolbar's 28px icon-button language; the labels
 * live in `aria-label`/`title`, not in the button body.
 */
import { t } from '../../i18n.ts'
import { ToolbarOverflow } from '../../kernel/ToolbarOverflow.tsx'
import { TOOL_CSS, ToolIcon } from './model-icons.tsx'
import type { BackgroundMode, ViewerSettings, ViewerToggle } from './useModelViewer.ts'

/** Props for the toolbar. */
export interface ModelToolbarProps {
  /** Whether the viewer is ready; loading and error states disable the tools. */
  readonly disabled: boolean
  /** Current toggle states. */
  readonly settings: ViewerSettings
  /** Hide the less-used toggles behind an overflow menu. */
  readonly compact?: boolean
  /** Reset the camera to its fitted position. */
  readonly onReset: () => void
  /** Flip one boolean viewport toggle. */
  readonly onToggle: (field: ViewerToggle) => void
  /** Cycle theme → light → dark → theme. */
  readonly onCycleBackground: () => void
}

/**
 * Label describing the current backdrop mode.
 * @param mode - theme-following or an explicit light/dark backdrop.
 * @returns localized button label.
 */
function backgroundLabel(mode: BackgroundMode): string {
  if (mode === 'light') return t('model.backgroundLight')
  if (mode === 'dark') return t('model.backgroundDark')
  return t('model.backgroundTheme')
}

/**
 * Render the tool row.
 * @param props - disabled state, settings, and callbacks.
 * @returns the style sheet and the five buttons.
 */
export function ModelToolbar({
  disabled,
  settings,
  compact = false,
  onReset,
  onToggle,
  onCycleBackground,
}: ModelToolbarProps) {
  const backgroundTitle = backgroundLabel(settings.background)
  const gridButton = (
    <button
      type="button" className="dsh-model-tool" disabled={disabled}
      onClick={() => onToggle('grid')}
      title={t('model.grid')} aria-label={t('model.grid')}
      aria-pressed={settings.grid} data-model-tool="grid"
    >
      <ToolIcon kind="grid" />
    </button>
  )
  const wireframeButton = (
    <button
      type="button" className="dsh-model-tool" disabled={disabled}
      onClick={() => onToggle('wireframe')}
      title={t('model.wireframe')} aria-label={t('model.wireframe')}
      aria-pressed={settings.wireframe} data-model-tool="wireframe"
    >
      <ToolIcon kind="wireframe" />
    </button>
  )
  const rotateButton = (
    <button
      type="button" className="dsh-model-tool" disabled={disabled}
      onClick={() => onToggle('autoRotate')}
      title={t('model.autoRotate')} aria-label={t('model.autoRotate')}
      aria-pressed={settings.autoRotate} data-model-tool="auto-rotate"
    >
      <ToolIcon kind="rotate" />
    </button>
  )

  return (
    <>
      <style>{TOOL_CSS}</style>
      <span style={toolsStyle}>
        <button
          type="button" className="dsh-model-tool" disabled={disabled}
          onClick={onReset}
          title={t('model.resetView')} aria-label={t('model.resetView')} data-model-tool="reset"
        >
          <ToolIcon kind="reset" />
        </button>
        <button
          type="button" className="dsh-model-tool" disabled={disabled}
          onClick={onCycleBackground}
          title={backgroundTitle} aria-label={backgroundTitle}
          data-model-tool="background" data-model-background={settings.background}
        >
          <ToolIcon kind={settings.background === 'light'
            ? 'light'
            : settings.background === 'dark' ? 'dark' : 'theme'}
          />
        </button>
        {compact
          ? <ToolbarOverflow label={t('common.more')}>{gridButton}{wireframeButton}{rotateButton}</ToolbarOverflow>
          : <>{gridButton}{wireframeButton}{rotateButton}</>}
      </span>
    </>
  )
}

const toolsStyle = {
  display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto', flexWrap: 'nowrap',
} as const
