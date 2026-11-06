/**
 * The model pane's view controls: reset, grid, wireframe, auto-rotate.
 *
 * Presentation only: the viewer owns the settings and applies them. Buttons
 * follow the host document toolbar's 28px icon-button language; the labels
 * live in `aria-label`/`title`, not in the button body.
 */
import { t } from '../../i18n.ts'
import { TOOL_CSS, ToolIcon } from './model-icons.tsx'
import type { ViewerSettings } from './useModelViewer.ts'

/** Props for the toolbar. */
export interface ModelToolbarProps {
  /** Whether the viewer is ready; loading and error states disable the tools. */
  readonly disabled: boolean
  /** Current toggle states. */
  readonly settings: ViewerSettings
  /** Reset the camera to its fitted position. */
  readonly onReset: () => void
  /** Flip one toggle. */
  readonly onToggle: (field: keyof ViewerSettings) => void
}

/**
 * Render the tool row.
 * @param props - disabled state, settings, and the two callbacks.
 * @returns the style sheet and the four buttons.
 */
export function ModelToolbar({ disabled, settings, onReset, onToggle }: ModelToolbarProps) {
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
          onClick={() => onToggle('grid')}
          title={t('model.grid')} aria-label={t('model.grid')}
          aria-pressed={settings.grid} data-model-tool="grid"
        >
          <ToolIcon kind="grid" />
        </button>
        <button
          type="button" className="dsh-model-tool" disabled={disabled}
          onClick={() => onToggle('wireframe')}
          title={t('model.wireframe')} aria-label={t('model.wireframe')}
          aria-pressed={settings.wireframe} data-model-tool="wireframe"
        >
          <ToolIcon kind="wireframe" />
        </button>
        <button
          type="button" className="dsh-model-tool" disabled={disabled}
          onClick={() => onToggle('autoRotate')}
          title={t('model.autoRotate')} aria-label={t('model.autoRotate')}
          aria-pressed={settings.autoRotate} data-model-tool="auto-rotate"
        >
          <ToolIcon kind="rotate" />
        </button>
      </span>
    </>
  )
}

const toolsStyle = {
  display: 'flex', alignItems: 'center', gap: 2, marginLeft: 'auto', flexWrap: 'wrap',
} as const
