/**
 * Media previews: native `<video>` / `<audio>` over the Host's byte-range route.
 *
 * `loading: 'renderer'` keeps the whole file out of the shared content
 * pipeline — the player streams from `/api/any-preview/media`, which answers
 * `206 Partial Content` so seeking works on a file of any size.
 */
import { useEffect, useRef, useState } from 'react'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'

/** Route owned by this package's Host half. */
const ROUTE = 'api/any-preview/media'

const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi',
  'mpg', 'mpeg', '3gp', '3g2', 'ts', 'm2ts',
] as const

const AUDIO_EXTENSIONS = [
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga',
  'opus', 'weba', 'aiff', 'aif', 'wma', 'mid', 'midi',
] as const

/** Build the authenticated route URL for one absolute path. */
function mediaUrl(path: string, download = false): string | undefined {
  try {
    const suffix = download ? '&download=1' : ''
    return new URL(`${ROUTE}?path=${encodeURIComponent(path)}${suffix}`, document.baseURI).href
  } catch {
    return undefined
  }
}

/** Final path segment for display, accepting either separator. */
function basenameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Human byte size for the footer. */
function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]!}`
}

/**
 * Tell the document owner the renderer has what it needs, once per version.
 * Without this the pane never leaves its loading state.
 */
function useRendererLoaded(content: PreviewBodyProps['content'], version: string | undefined): void {
  const reported = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (reported.current === version) return
    reported.current = version
    content.loaded(version)
  }, [content, version])
}

interface MediaBodyProps extends PreviewBodyProps {
  readonly kind: 'video' | 'audio'
}

function MediaBody({ kind, content, resourceAddress, useResource }: MediaBodyProps) {
  const meta = useResource?.(resourceAddress)?.value
  const absolutePath = meta?.absolutePath
  const version = meta?.version
  const [failed, setFailed] = useState(false)
  useRendererLoaded(content, version)

  const remote = typeof absolutePath === 'string' ? mediaUrl(absolutePath) : undefined
  const download = typeof absolutePath === 'string' ? mediaUrl(absolutePath, true) : undefined
  const name = typeof absolutePath === 'string' ? basenameOf(absolutePath) : ''
  const bytes = formatBytes(meta?.size)
  const metaLine = bytes === '' ? name : `${name} · ${bytes}`

  useEffect(() => {
    setFailed(false)
  }, [remote])

  if (remote === undefined) {
    return <Status text={absolutePath === undefined ? '无法读取此文件的路径。' : '正在载入媒体…'} />
  }

  const playerKey = `${remote}|${content.kind === 'renderer' ? String(content.revision) : '0'}|${version ?? ''}`

  if (failed) {
    return (
      <div style={styles.frame}>
        <Status text="此浏览器无法播放这个格式，可以下载后用本机播放器打开。" />
        {download !== undefined && (
          <a style={styles.link} href={download} download={name}>下载 {metaLine}</a>
        )}
      </div>
    )
  }

  const player = kind === 'video'
    ? (
        <video
          key={playerKey}
          src={remote}
          controls
          playsInline
          preload="metadata"
          style={styles.video}
          onError={() => setFailed(true)}
        />
      )
    : (
        <audio
          key={playerKey}
          src={remote}
          controls
          preload="metadata"
          style={styles.audio}
          onError={() => setFailed(true)}
        />
      )

  return (
    <div style={styles.frame} data-any-preview-media={kind}>
      <div style={styles.stage}>
        {kind === 'audio'
          ? (
              <div style={styles.audioCard}>
                <div style={styles.audioName}>{metaLine}</div>
                {player}
              </div>
            )
          : player}
      </div>
      <div style={styles.footer}>
        {kind === 'audio' ? null : <span style={styles.name}>{metaLine}</span>}
        {download !== undefined && <a style={styles.link} href={download} download={name}>下载</a>}
        <a style={styles.link} href={remote} target="_blank" rel="noreferrer">在新标签页打开</a>
      </div>
    </div>
  )
}

function Status({ text }: { readonly text: string }) {
  return (
    <div style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 16 }}>
      <p style={{ margin: 0, fontSize: 12, textAlign: 'center', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' }}>
        {text}
      </p>
    </div>
  )
}

const styles = {
  frame: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    minHeight: 0,
    padding: 12,
    overflow: 'auto',
    fontFamily: 'var(--dsw-font-family)',
    fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)',
  },
  stage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 0,
    flex: '0 1 auto',
  },
  video: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: '72vh',
    background: '#000',
    borderRadius: 8,
    outline: 'none',
  },
  audioCard: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    width: '100%',
    maxWidth: 520,
    padding: 16,
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  audio: { width: '100%', outline: 'none' },
  audioName: {
    fontWeight: 600,
    overflowWrap: 'anywhere',
    color: 'var(--dsw-alias-label-primary)',
  },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 14px',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
    fontSize: 12,
  },
  name: { overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)' },
  link: { color: 'var(--dsw-alias-label-secondary)', textDecoration: 'underline' },
} as const

function VideoBody(props: PreviewBodyProps) {
  return <MediaBody {...props} kind="video" />
}

function AudioBody(props: PreviewBodyProps) {
  return <MediaBody {...props} kind="audio" />
}

/** Video containers and codecs browsers commonly expose to `<video>`. */
export const videoPreview: PreviewModule = {
  id: 'dsh-any-preview/video',
  extensions: VIDEO_EXTENSIONS,
  binary: VIDEO_EXTENSIONS,
  load: 'renderer',
  wrap: false,
  title: () => '视频',
  Body: VideoBody,
}

/** Audio containers and codecs browsers commonly expose to `<audio>`. */
export const audioPreview: PreviewModule = {
  id: 'dsh-any-preview/audio',
  extensions: AUDIO_EXTENSIONS,
  binary: AUDIO_EXTENSIONS,
  load: 'renderer',
  wrap: false,
  title: () => '音频',
  Body: AudioBody,
}
