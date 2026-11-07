/**
 * Clip picker, transport button and scrubber for glTF animations.
 *
 * A file can carry several clips: a bone clip and a separate shape-key (facial)
 * clip are common. They target disjoint tracks and can play together, so the
 * strip exposes a compact multi-select menu instead of a row of buttons; the
 * menu scales to models with many clips.
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n.ts'
import { TOOL_CSS, ToolIcon } from './model-icons.tsx'
import type { ModelAnimationInfo } from './animation-runtime.ts'

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
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const doc = triggerRef.current?.ownerDocument
    if (doc === undefined || doc === null) return
    const closeOnOutside = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (menuRef.current?.contains(target) === true) return
      if (triggerRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    doc.addEventListener('pointerdown', closeOnOutside, true)
    doc.addEventListener('keydown', closeOnEscape)
    return () => {
      doc.removeEventListener('pointerdown', closeOnOutside, true)
      doc.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (clips.length === 0) return null
  const duration = active.reduce(
    (longest, index) => Math.max(longest, clips[index]?.duration ?? 0),
    0,
  )
  const position = Math.min(Math.max(0, time), duration)
  const playable = active.length > 0 && duration > 0
  const activeNames = active.map((index) => {
    const clip = clips[index]
    return clip === undefined ? '' : clipLabel(clip, index)
  }).filter((name) => name !== '')

  return (
    <div style={barStyle} data-model-animation="true">
      <style>{TOOL_CSS}</style>
      <style>{MENU_CSS}</style>
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
      ) : null}
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
      {clips.length > 1 && (
        <span style={menuWrapStyle}>
          <button
            ref={triggerRef}
            type="button"
            className="dsh-model-clip-trigger"
            style={triggerStyle}
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={t('model.animation')}
            title={activeNames.length > 0 ? activeNames.join(' · ') : t('model.animation')}
          >
            <span>{t('model.animation')} {active.length}/{clips.length}</span>
            <span aria-hidden="true" style={chevronStyle(open)}>▾</span>
          </button>
          {open && (
            <div
              ref={menuRef}
              style={menuStyle}
              role="group"
              aria-label={t('model.animation')}
            >
              <div style={menuListStyle}>
                {clips.map((clip, index) => {
                  const isActive = active.includes(index)
                  const label = clipLabel(clip, index)
                  return (
                    <label
                      key={index}
                      className="dsh-model-clip-row"
                      style={rowStyle}
                      title={label}
                    >
                      <input
                        type="checkbox"
                        style={checkboxStyle}
                        checked={isActive}
                        onChange={() => onToggleClip(index)}
                      />
                      <span style={rowLabelStyle}>{label}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </span>
      )}
    </div>
  )
}

const MENU_CSS = `
  .dsh-model-clip-trigger:focus-visible {
    outline: 2px solid var(--dsw-alias-brand-primary);
    outline-offset: 1px;
  }
  .dsh-model-clip-row:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
`

const barStyle = {
  boxSizing: 'border-box' as const,
  display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
  height: 32, padding: '0 12px 0 16px', fontSize: 12, lineHeight: '16px',
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
} as const

const nameStyle = {
  maxWidth: '35%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)',
} as const

const rangeStyle = {
  flex: '1 1 auto', minWidth: 48, height: 14, margin: 0,
  accentColor: 'var(--dsw-alias-brand-primary)',
} as const

const timeStyle = {
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)',
} as const

const menuWrapStyle = {
  position: 'relative', display: 'inline-flex', flex: '0 0 auto',
} as const

const triggerStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto',
  height: 24, padding: '0 8px', borderRadius: 999,
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit', fontSize: 11, lineHeight: '16px', cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

/** Dropdown chevron; kept as a function so the transition stays inline. */
function chevronStyle(open: boolean) {
  return {
    display: 'inline-block', fontSize: 9, lineHeight: 1,
    transform: open ? 'rotate(180deg)' : 'none',
    transition: 'transform 120ms ease',
  } as const
}

const menuStyle = {
  position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 40,
  width: 240, maxWidth: '80vw', maxHeight: 260,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  padding: 4, borderRadius: 'var(--dsw-radius-md, 8px)',
  background: 'var(--dsw-alias-bg-base)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
} as const

const menuListStyle = {
  display: 'flex', flexDirection: 'column', gap: 1,
  minHeight: 0, overflowY: 'auto',
} as const

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
  padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 11,
} as const

const checkboxStyle = {
  flex: 'none', width: 13, height: 13, margin: 0,
  accentColor: 'var(--dsw-alias-brand-primary)',
} as const

const rowLabelStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
} as const
