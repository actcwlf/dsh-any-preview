/**
 * Clip picker, transport button and scrubber for a glTF animation.
 *
 * Rendered only when the model carries clips. The play button follows the
 * host's 28px tool-button language; the select and range stay compact so the
 * strip adds one thin row rather than competing with the viewport.
 */
import { t } from '../../i18n.ts'
import { TOOL_CSS, ToolIcon } from './model-icons.tsx'
import type { ModelAnimationInfo } from './useModelViewer.ts'

/** What the animation strip needs from the viewer. */
export interface ModelAnimationBarProps {
  readonly clips: readonly ModelAnimationInfo[]
  readonly index: number
  readonly playing: boolean
  readonly time: number
  onSelect(index: number): void
  onToggle(): void
  onSeek(time: number): void
}

/**
 * Short clock for a clip position.
 * @param seconds - seconds into the clip.
 * @returns `m:ss.t`.
 */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(safe)
  const tenths = Math.min(9, Math.floor((safe - whole) * 10))
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}.${String(tenths)}`
}

export function ModelAnimationBar({
  clips,
  index,
  playing,
  time,
  onSelect,
  onToggle,
  onSeek,
}: ModelAnimationBarProps) {
  const clip = clips[index]
  if (clip === undefined) return null
  const duration = Number.isFinite(clip.duration) ? Math.max(0, clip.duration) : 0
  const position = Math.min(Math.max(0, time), duration)
  const name = clip.name.trim() === '' ? t('model.animationName', { n: index + 1 }) : clip.name

  return (
    <div style={barStyle} data-model-animation="true">
      <style>{TOOL_CSS}</style>
      <button
        type="button"
        className="dsh-model-tool"
        onClick={onToggle}
        disabled={clips.length === 0 || duration <= 0}
        aria-label={playing ? t('model.pause') : t('model.play')}
        title={playing ? t('model.pause') : t('model.play')}
        data-model-animation-toggle="true"
      >
        <ToolIcon kind={playing ? 'pause' : 'play'} />
      </button>
      {clips.length > 1 ? (
        <select
          style={selectStyle}
          value={String(index)}
          onChange={(event) => onSelect(Number(event.currentTarget.value))}
          aria-label={t('model.animation')}
          title={t('model.animation')}
        >
          {clips.map((entry, positionIndex) => (
            <option key={positionIndex} value={String(positionIndex)}>
              {entry.name.trim() === ''
                ? t('model.animationName', { n: positionIndex + 1 })
                : entry.name}
            </option>
          ))}
        </select>
      ) : (
        <span style={nameStyle} title={name}>{name}</span>
      )}
      <input
        type="range"
        style={rangeStyle}
        min={0}
        max={duration > 0 ? duration : 0.001}
        step={0.01}
        value={position}
        disabled={duration <= 0}
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
        aria-label={t('model.animation')}
      />
      <span style={timeStyle}>
        {formatClock(position)} / {formatClock(duration)}
      </span>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
  padding: '2px 8px 2px 10px', fontSize: 11,
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
} as const

const nameStyle = {
  maxWidth: '35%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)',
} as const

const selectStyle = {
  ...nameStyle,
  maxWidth: '40%',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--dsw-radius-sm)',
  padding: '1px 4px',
  font: 'inherit',
} as const

const rangeStyle = {
  flex: '1 1 auto', minWidth: 60, height: 14, margin: 0,
  accentColor: 'var(--dsw-alias-brand-primary)',
} as const

const timeStyle = {
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)',
} as const
