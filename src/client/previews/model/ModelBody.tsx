/**
 * The 3D pane's shell: file name, stats, toolbar and the canvas mount point.
 *
 * Rendering only. The WebGL lifecycle, decoding and theme following live in
 * `useModelViewer`; the controls and overlay are their own components so this
 * file stays readable.
 */
import { t } from '../../i18n.ts'
import { useLocale } from '../../useLocale.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_ROOT } from '../../kernel/layout.ts'
import { ModelOverlay } from './ModelOverlay.tsx'
import { ModelToolbar } from './ModelToolbar.tsx'
import { ModelAnimationBar } from './ModelAnimationBar.tsx'
import { useModelViewer } from './useModelViewer.ts'
import type { PreviewBodyProps } from '../../kernel/types.ts'

/**
 * Final path segment for display.
 * @param path - absolute path, either separator.
 * @returns the file name.
 */
function basenameOf(path: string): string {
  const name = path.replaceAll('\\', '/')
  return name.slice(name.lastIndexOf('/') + 1)
}

/**
 * Compact length for the info bar; units are whatever the file uses.
 * @param value - model-space length.
 * @returns a short decimal string.
 */
function measure(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/u, '')
  if (abs >= 0.01) return value.toFixed(3).replace(/\.?0+$/u, '')
  return value.toExponential(1)
}

export function ModelBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const {
    view, progress, absolutePath, mountRef, settings, resetView, toggle, retry,
    animations, animationActive, animationPlaying, animationTime,
    cycleBackground, toggleAnimationClip, toggleAnimation, seekAnimation,
  } = useModelViewer(content, resourceAddress, useResource)
  const ready = view.status === 'ready'
  const loadingText = view.phase === 'decoding'
    ? t('model.decoding')
    : progress === undefined
      ? t('model.loading')
      : progress.total === undefined
        ? t('model.loadingBytes', { loaded: formatBytes(progress.loaded) })
        : t('model.loadingProgress', {
          loaded: formatBytes(progress.loaded),
          total: formatBytes(progress.total),
        })
  const statsText = ready
    ? [
      view.triangles > 0 ? t('model.triangles', { count: view.triangles.toLocaleString('en-US') }) : '',
      view.vertices > 0 ? t('model.vertices', { count: view.vertices.toLocaleString('en-US') }) : '',
      view.materials > 0 ? t('model.materials', { count: String(view.materials) }) : '',
      view.width > 0
        ? t('model.dimensions', { x: measure(view.width), y: measure(view.height), z: measure(view.depth) })
        : '',
    ].join('')
    : ''

  return (
    <div style={PANE_ROOT} data-model-status={view.status}>
      <div style={barStyle}>
        <span style={titleStyle} title={absolutePath}>
          {typeof absolutePath === 'string' ? basenameOf(absolutePath) : t('model.title')}
        </span>
        {statsText !== '' && <span style={statsStyle}>{statsText}</span>}
        <ModelToolbar
          disabled={!ready}
          settings={settings}
          onReset={resetView}
          onToggle={toggle}
          onCycleBackground={cycleBackground}
        />
      </div>
      {view.note !== '' && <div style={noteStyle}>{view.note}</div>}
      {ready && animations.length > 0 && (
        <ModelAnimationBar
          clips={animations}
          active={animationActive}
          playing={animationPlaying}
          time={animationTime}
          onToggleClip={toggleAnimationClip}
          onToggle={toggleAnimation}
          onSeek={seekAnimation}
        />
      )}
      <div
        style={viewportStyle}
        title={t('model.hint')}
        aria-label={t('model.title')}
        role="group"
      >
        <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
        <ModelOverlay
          status={view.status}
          detail={view.detail}
          retryable={view.retryable}
          loadingText={loadingText}
          onRetry={retry}
        />
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
  padding: '3px 8px 3px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const titleStyle = {
  minWidth: 0, maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)',
} as const

const statsStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)', fontSize: 11,
} as const

const noteStyle = {
  padding: '4px 10px', fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const viewportStyle = {
  position: 'relative', flex: '1 1 auto', minHeight: 0,
} as const
