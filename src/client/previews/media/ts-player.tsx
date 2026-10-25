/**
 * MPEG-TS playback: remux to fragmented MP4 with mux.js, then let MediaSource
 * play it. No decoding and no transcoding happen here — the packets are copied
 * into a container the browser can demux itself.
 */
import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n.ts'
import { loadMux } from '../../kernel/mux-loader.ts'

/** Refuse to hold a transport stream much larger than this in memory. */
const MAX_TS_BYTES = 256 * 1024 * 1024

interface TsPlayerProps {
  readonly src: string
}

export function TsPlayer({ src }: TsPlayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [message, setMessage] = useState(t('media.tsLoading'))

  useEffect(() => {
    let alive = true
    let objectUrl = ''
    void (async () => {
      try {
        const [mux, response] = await Promise.all([loadMux(), fetch(src)])
        if (!response.ok) throw new Error(`ts fetch failed: ${String(response.status)}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > MAX_TS_BYTES) throw new Error(t('media.tsTooLarge'))
        if (!alive) return

        const transmuxer = new mux.Transmuxer()
        let init: Uint8Array | undefined
        const segments: Uint8Array[] = []
        transmuxer.on('data', (segment) => {
          if (init === undefined && segment.initSegment !== undefined) init = segment.initSegment
          segments.push(segment.data)
        })
        transmuxer.push(bytes)
        transmuxer.flush()
        if (init === undefined || segments.length === 0) throw new Error(t('media.tsNotPlayable'))

        const type = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'
        if (!MediaSource.isTypeSupported(type)) throw new Error(t('media.tsCodecUnsupported'))

        const mediaSource = new MediaSource()
        const video = document.createElement('video')
        video.controls = true
        video.autoplay = true
        video.style.width = '100%'
        video.style.display = 'block'
        objectUrl = URL.createObjectURL(mediaSource)
        video.src = objectUrl
        hostRef.current?.appendChild(video)

        await new Promise<void>((resolve) => {
          mediaSource.addEventListener('sourceopen', () => { resolve() }, { once: true })
        })
        const sourceBuffer = mediaSource.addSourceBuffer(type)
        const append = (data: Uint8Array): Promise<void> => new Promise((resolve, reject) => {
          sourceBuffer.addEventListener('updateend', () => { resolve() }, { once: true })
          sourceBuffer.addEventListener('error', () => { reject(new Error('append failed')) }, { once: true })
          sourceBuffer.appendBuffer(new Uint8Array(data) as unknown as BufferSource)
        })
        await append(init)
        for (const segment of segments) {
          if (!alive) return
          await append(segment)
        }
        mediaSource.endOfStream()
        if (alive) setMessage('')
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : t('media.tsNotPlayable'))
      }
    })()
    return () => {
      alive = false
      if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div ref={hostRef} />
      {message !== '' && <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)' }}>{message}</p>}
    </div>
  )
}
