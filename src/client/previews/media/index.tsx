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
import { TsPlayer } from './ts-player.tsx'
import { fileSize } from '../../kernel/zip.ts'
import { MAX_BUFFER_BYTES, bufferingDecision } from './decision.ts'

const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi',
  'mpg', 'mpeg', '3gp', '3g2', 'm2ts',
    // .ts is deliberately absent: most .ts files are TypeScript sources, and
    // renderer selection is path-only, so claiming the extension would send code
    // to a media player. The built-in text preview owns that extension.
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


/** Temporary diagnostics in the footer; off for release. */
const MEDIA_DEBUG = false

/**
 * Which transport the desktop uses.
 *
 * `false` (today): the shell's forwarding proxy withholds `Content-Length`, so
 * a proxied media response reports no seekable range. The desktop therefore
 * addresses the same bytes over the signed loopback route, which Chromium's
 * http media loader seeks in. If that route is unavailable or fails, the pane
 * falls back to the proxied URL and buffers the file locally to restore
 * seeking.
 *
 * `true` (once DSH preserves `Content-Length`): the proxied URL seeks natively
 * and the loopback route is bypassed entirely — no minting, no extra server
 * route. The Blob fallback stays in place either way, so an older shell still
 * gets a working scrubber.
 *
 * This is a code switch on purpose: the transport is a property of the shell
 * version, and flipping one constant is clearer than probing every open.
 */
const TRUST_CONTENT_LENGTH = false

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
  const [size, setSize] = useState<number | undefined>(meta?.size)
  const [diag, setDiag] = useState('')
  const [lanSrc, setLanSrc] = useState('')
  const [lanStatus, setLanStatus] = useState(0)
  const [errCode, setErrCode] = useState(0)
  const resumeAt = useRef<number | null>(null)
  const probing = useRef(false)
  const fellBack = useRef(false)

  const remote = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const download = typeof absolutePath === 'string' ? fileUrl(absolutePath, true) : undefined
  const name = typeof absolutePath === 'string' ? basenameOf(absolutePath) : ''
  const bytes = formatBytes(size ?? meta?.size)
  const metaLine = bytes === '' ? name : `${name} · ${bytes}`

  // Desktop only: the page is served from dsh-app://, whose proxy withholds
  // Content-Length and makes the element report no seekable range. A browser
  // page already seeks natively, so it keeps the same-origin URL.
  useEffect(() => {
    if (remote === undefined) return
    // Content-Length mode: the proxied URL is the transport, nothing to mint.
    if (TRUST_CONTENT_LENGTH) return
    if (typeof location === 'undefined' || !location.protocol.startsWith('dsh-app')) return
    let alive = true
    void (async () => {
      try {
        const probe = new URL(remote)
        probe.searchParams.set('lan', '1')
        const response = await fetch(probe)
        if (!response.ok) return
        const body = await response.json() as { url?: unknown }
        if (typeof body.url !== 'string' || body.url === '') return
        if (!alive) return
        setLanSrc(body.url)
        // Probe the signed URL so a failure can report the status even when
        // the media element itself only says "cannot play".
        try {
          const probeResponse = await fetch(body.url, { headers: { Range: 'bytes=0-1' } })
          if (alive) setLanStatus(probeResponse.status)
          await probeResponse.body?.cancel()
        } catch {
          if (alive) setLanStatus(-1)
        }
      } catch {
        // Leave the proxied URL in place.
      }
    })()
    return () => { alive = false }
  }, [remote])

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
      void (async () => {
        // Diagnostic: what the element believes, next to whether the loopback
        // HTTP URL answers at all.
        const duration = Number.isFinite(element.duration) ? element.duration.toFixed(2) : '?'
        let lanStatus = 0
        if (lanSrc !== '') {
          try {
            const response = await fetch(lanSrc, { headers: { Range: 'bytes=0-1' } })
            lanStatus = response.status
            await response.body?.cancel()
          } catch {
            lanStatus = -1
          }
        }
        setDiag(`seekable=${end.toFixed(2)} dur=${duration} lan=${lanStatus}`)
        // The desktop file resource usually reports no size. Without one the
        // buffering cap cannot apply, and any file — however large — would be
        // pulled into memory. The route's Content-Range carries the real
        // length, so ask for it before deciding.
        const resolved = meta?.size ?? await fileSize(remote)
        if (resolved !== undefined && resolved !== size) setSize(resolved)
        const decision = bufferingDecision(end, resolved)
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
      })()
    }, 300)
  }

  const activeSrc = bufferedUrl !== '' ? bufferedUrl : lanSrc !== '' ? lanSrc : remote
  // Transport streams carry H.264/AAC inside a container the browser cannot
  // demux; remux them to fMP4 instead of asking the element to play them.
  const suffix = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if ((suffix === 'ts' || suffix === 'm2ts') && activeSrc !== undefined) return <TsPlayer src={activeSrc} />

  if (remote === undefined) {
    return <Status text={absolutePath === undefined ? t('media.noPath') : t('media.loading')} />
  }

  const playerKey = `${remote}|${content.kind === 'renderer' ? String(content.revision) : '0'}|${version ?? ''}`

  if (failed) {
    // 4 is MEDIA_ERR_SRC_NOT_SUPPORTED: the bytes arrived but nothing could
    // decode them. Anything else means the stream itself was not obtainable.
    const message = errCode === 4 ? t('media.unsupported') : t('media.streamFailed')
    return (
      <div style={styles.frame}>
        <Status text={message} />
        {MEDIA_DEBUG && (
          <p style={styles.notice}>{`lan=${lanStatus} code=${errCode} src=${lanSrc === '' ? 'api' : 'lan'}`}</p>
        )}
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
          onError={event => { setErrCode(event.currentTarget.error?.code ?? -1); if (lanSrc !== '' && !fellBack.current) { fellBack.current = true; setLanSrc(''); return } setFailed(true) }}
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
          onError={event => { setErrCode(event.currentTarget.error?.code ?? -1); if (lanSrc !== '' && !fellBack.current) { fellBack.current = true; setLanSrc(''); return } setFailed(true) }}
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
        {MEDIA_DEBUG && diag !== '' && <span style={styles.name}>{diag}</span>}
        {download !== undefined && <a style={styles.link} href={download} download={name}>{t('common.download')}</a>}
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
