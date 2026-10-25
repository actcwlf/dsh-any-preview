/**
 * Media previews: native `<video>` / `<audio>` over the Host's byte-range route.
 *
 * `loading: 'renderer'` keeps the whole file out of the shared content
 * pipeline — the player streams from `/api/any-preview/media`, which answers
 * `206 Partial Content` for real range requests.
 *
 * The desktop shell serves the page from `dsh-app://` and forwards `/api`
 * through a proxy that withholds `Content-Length`. Chromium then treats the
 * stream as length-unknown and reports `seekable` as `[0, 0]`, so the scrubber
 * cannot move. When that is detected the body pulls the file into a Blob
 * instead: seeking works again at the cost of memory, which is why it is
 * bounded by a cap and explained in the UI rather than done silently.
 */
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useEffect, useRef, useState } from 'react'
import type { SyntheticEvent } from 'react'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { MAX_BUFFER_BYTES, bufferingDecision } from './decision.ts'

const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi',
  'mpg', 'mpeg', '3gp', '3g2', 'ts', 'm2ts',
] as const

const AUDIO_EXTENSIONS = [
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga',
  'opus', 'weba', 'aiff', 'aif', 'wma', 'mid', 'midi',
] as const

/** Final path segment for display, accepting either separator. */
function basenameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}


interface MediaBodyProps extends PreviewBodyProps {
  readonly kind: 'video' | 'audio'
}

function MediaBody({ kind, content, resourceAddress, useResource }: MediaBodyProps) {
  useLocale()
  const { meta, absolutePath, version } = useDocument(content, resourceAddress, useResource)
  const [failed, setFailed] = useState(false)
  const [info, setInfo] = useState('')
  const [bufferedUrl, setBufferedUrl] = useState('')
  const [buffering, setBuffering] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const resumeAt = useRef<number | null>(null)
  const probing = useRef(false)

  const remote = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const download = typeof absolutePath === 'string' ? fileUrl(absolutePath, true) : undefined
  const name = typeof absolutePath === 'string' ? basenameOf(absolutePath) : ''
  const bytes = formatBytes(meta?.size)
  const metaLine = bytes === '' ? name : `${name} · ${bytes}`

  useEffect(() => {
    setFailed(false)
  }, [remote])

  // An object URL owns a copy of the file; release it when it is replaced or
  // the tab goes away.
  useEffect(() => () => {
    if (bufferedUrl !== '') URL.revokeObjectURL(bufferedUrl)
  }, [bufferedUrl])

  /**
   * Restore seeking when the platform hides the byte length. Chromium reports
   * an empty seekable range for a stream of unknown size, which is exactly what
   * the desktop shell's forwarding proxy produces.
   */
  const onLoadedMetadata = (event: SyntheticEvent<HTMLMediaElement>): void => {
    const element = event.currentTarget
    // Read the real metadata once the browser has it: duration in particular is
    // the fastest way to tell a truncated file from a short one.
    const facts: string[] = []
    if (Number.isFinite(element.duration)) facts.push(t('media.seconds', { value: element.duration.toFixed(1) }))
    if (element instanceof HTMLVideoElement && element.videoWidth > 0) {
      facts.push(`${String(element.videoWidth)}×${String(element.videoHeight)}`)
    }
    setInfo(facts.join(' · '))
    if (resumeAt.current !== null) {
      try {
        element.currentTime = resumeAt.current
      } catch {
        // The source changed underneath; starting from zero is acceptable.
      }
      resumeAt.current = null
      return
    }
    if (probing.current || remote === undefined) return
    probing.current = true
    window.setTimeout(() => {
      probing.current = false
      if (!element.isConnected) return
      const end = element.seekable.length > 0 ? element.seekable.end(0) : 0
      const decision = bufferingDecision(end, meta?.size)
      if (decision === 'none') return
      if (decision === 'blocked') {
        setBlocked(true)
        return
      }
      resumeAt.current = element.currentTime
      setBuffering(true)
      void fetch(remote)
        .then((response) => {
          if (!response.ok) throw new Error(`media fetch failed: ${String(response.status)}`)
          return response.blob()
        })
        .then((blob) => {
          if (blob.size > MAX_BUFFER_BYTES) {
            setBlocked(true)
            return
          }
          setBufferedUrl(URL.createObjectURL(blob))
        })
        .catch(() => {
          setBlocked(true)
        })
        .finally(() => {
          setBuffering(false)
        })
    }, 300)
  }

  const activeSrc = bufferedUrl === '' ? remote : bufferedUrl

  if (remote === undefined) {
    return <Status text={absolutePath === undefined ? t('media.noPath') : t('media.loading')} />
  }

  const playerKey = `${remote}|${content.kind === 'renderer' ? String(content.revision) : '0'}|${version ?? ''}`

  if (failed) {
    return (
      <div style={styles.frame}>
        <Status text={t('media.unsupported')} />
        {download !== undefined && (
          <a style={styles.link} href={download} download={name}>{t('media.downloadNamed', { name: metaLine })}</a>
        )}
      </div>
    )
  }

  const player = kind === 'video'
    ? (
        <video
          key={playerKey}
          src={activeSrc}
          controls
          playsInline
          preload="metadata"
          style={styles.video}
          onLoadedMetadata={onLoadedMetadata}
          onError={() => setFailed(true)}
        />
      )
    : (
        <audio
          key={playerKey}
          src={activeSrc}
          controls
          preload="metadata"
          style={styles.audio}
          onLoadedMetadata={onLoadedMetadata}
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
      {(buffering || blocked) && (
        <p style={styles.notice}>
          {buffering
            ? t('media.buffering')
            : t('media.cannotSeek', { size: bytes === '' ? '' : `（${bytes}）`, limit: String(MAX_BUFFER_BYTES / 1024 / 1024) })}
        </p>
      )}
      <div style={styles.footer}>
        {kind === 'audio' ? null : <span style={styles.name}>{metaLine}</span>}
        {info !== '' && <span style={styles.name}>{info}</span>}
        {download !== undefined && <a style={styles.link} href={download} download={name}>{t('common.download')}</a>}
        <a style={styles.link} href={remote} target="_blank" rel="noreferrer">{t('common.openInNewTab')}</a>
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
  notice: {
    margin: 0,
    maxWidth: '40em',
    textAlign: 'center',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-tertiary)',
  },
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
  title: () => t('media.video'),
  Body: VideoBody,
}

/** Audio containers and codecs browsers commonly expose to `<audio>`. */
export const audioPreview: PreviewModule = {
  id: 'dsh-any-preview/audio',
  extensions: AUDIO_EXTENSIONS,
  binary: AUDIO_EXTENSIONS,
  load: 'renderer',
  wrap: false,
  title: () => t('media.audio'),
  Body: AudioBody,
}
