/**
 * Clip picker, transport button and scrubber for glTF animations.
 *
 * A file can carry several clips: a bone clip and a separate shape-key (facial)
 * clip are common. They target disjoint tracks and can play together, so the
 * strip exposes every clip as a toggle rather than a single-choice select.
 */
import { t } from '../../i18n.ts'
import { TOOL_CSS, ToolIcon } from './model-icons.tsx'
import type { ModelAnimationInfo } from './useModelViewer.ts'

/** What the animation strip needs from the viewer. */
export interface ModelAnimationBarProps {
  readonly clips: readonly ModelAnimationInfo[]
  /** Clip indexes currently active; more than one can play at once. */
  readonly active: readonly number[]
  readonly playing: boolean
  readonly time: number
  onToggleClip(index: number): void
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

/**
 * Display name for a clip.
 * @param clip - clip metadata.
 * @param index - position, used for unnamed clips.
 * @returns the name or a localized fallback.
 */
function clipLabel(clip: ModelAnimationInfo, index: number): string {
  return clip.name.trim() === '' ? t('model.animationName', { n: index + 1 }) : clip.name
}

export function ModelAnimationBar({
  clips,
  active,
  playing,
  time,
  onToggleClip,
  onToggle,
  onSeek,
}: ModelAnimationBarProps) {
  if (clips.length === 0) return null
  const duration = active.reduce(
    (longest, index) => Math.max(longest, clips[index]?.duration ?? 0),
    0,
  )
  const position = Math.min(Math.max(0, time), duration)
  const playable = active.length > 0 && duration > 0

  return (
    <div style={barStyle} data-model-animation="true">
      <style>{TOOL_CSS}</style>
      <button
        type="button"
        className="dsh-model-tool"
        onClick={onToggle}
        disabled={!playable}
        aria-label={playing ? t('model.pause') : t('model.play')}
        title={playing ? t('model.pause') : t('model.play')}
        data-model-animation-toggle="true"
      >
        <ToolIcon kind={playing ? 'pause' : 'play'} />
      </button>
      {clips.length === 1 && clips[0] !== undefined ? (
        <span style={nameStyle} title={clipLabel(clips[0], 0)}>
          {clipLabel(clips[0], 0)}
        </span>
      ) : (
        <div style={clipsStyle} role="group" aria-label={t('model.animation')}>
          {clips.map((clip, index) => {
            const isActive = active.includes(index)
            const label = clipLabel(clip, index)
            return (
              <button
                key={index}
                type="button"
                style={isActive ? activeChipStyle : chipStyle}
                onClick={() => onToggleClip(index)}
                aria-pressed={isActive}
                title={label}
              >
                {label}
              </button>
            )
          })}
        </div>
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

const clipsStyle = {
  display: 'flex', gap: 4, flex: '0 1 auto', minWidth: 0, maxWidth: '48%',
  overflowX: 'auto', overflowY: 'hidden', padding: '1px 0',
} as const

const chipStyle = {
  flex: 'none', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', padding: '1px 7px', fontSize: 10, lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)', background: 'transparent',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: 999, cursor: 'pointer',
  transition: 'background-color 120ms ease, color 120ms ease, border-color 120ms ease',
} as const

const activeChipStyle = {
  ...chipStyle,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
  borderColor: 'var(--dsw-alias-brand-primary)',
} as const

const rangeStyle = {
  flex: '1 1 auto', minWidth: 60, height: 14, margin: 0,
  accentColor: 'var(--dsw-alias-brand-primary)',
} as const

const timeStyle = {
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)',
} as const
