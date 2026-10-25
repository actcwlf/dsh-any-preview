/** Font preview: load the file into a FontFace and draw a specimen. */
import { errorText } from '../../kernel/errors.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useEffect, useState } from 'react'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'

/** Family name the preview owns, so it never collides with page fonts. */
const FAMILY = 'dsh-any-preview-font'

const SAMPLE = 'The quick brown fox jumps over the lazy dog'
const SIZES = [12, 16, 22, 30, 44] as const
const GLYPHS = Array.from({ length: 95 }, (_unused, index) => String.fromCharCode(32 + index))

export function FontBody({ content }: PreviewBodyProps) {
  useLocale()
  const bytes = content.kind === 'bytes' ? content.data : undefined
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')

  useEffect(() => {
    if (bytes === undefined) return
    let face: FontFace | undefined
    let alive = true
    void (async () => {
      try {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        // `slice` over an ArrayBufferLike yields ArrayBuffer at runtime; the
        // cast only pins the union back to the DOM signature.
        const loaded = new FontFace(FAMILY, buffer as ArrayBuffer)
        await loaded.load()
        if (!alive) return
        document.fonts.add(loaded)
        face = loaded
        setStatus('ready')
      } catch (error) {
        if (!alive) return
        setStatus('error')
        setDetail(errorText(error, 'font.parseFailed'))
      }
    })()
    return () => {
      alive = false
      if (face !== undefined) document.fonts.delete(face)
    }
  }, [bytes])

  if (status !== 'ready') {
    return (
      <div style={PANE_FILL}>
        {status === 'loading' ? t('font.loading') : t('common.error', { detail })}
      </div>
    )
  }

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span>{t('font.sample')}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('font.loaded')}</span>
      </div>
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '12px 16px' }}>
        {SIZES.map(size => (
          <div key={size} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 2 }}>
              {size}px
            </div>
            <div style={{ fontFamily: FAMILY, fontSize: size, lineHeight: 1.35, color: 'var(--dsw-alias-label-primary)' }}>
              {SAMPLE}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 18, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 }}>
          {t('font.glyphs')}
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))',
          gap: 4,
          fontFamily: FAMILY,
          fontSize: 20,
          color: 'var(--dsw-alias-label-primary)',
        }}>
          {GLYPHS.map((glyph, index) => (
            <div
              key={index}
              title={`U+${(32 + index).toString(16).toUpperCase().padStart(4, '0')}`}
              style={{
                display: 'grid',
                placeItems: 'center',
                height: 34,
                borderRadius: 4,
                background: 'var(--dsw-alias-bg-layer-2)',
              }}
            >
              {glyph === ' ' ? '\u00a0' : glyph}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'] as const

/** What the client entry registers for this format. */
export const fontPreview: PreviewModule = {
  id: 'dsh-any-preview/font',
  extensions: FONT_EXTENSIONS,
  binary: FONT_EXTENSIONS,
  load: 'bytes-complete',
  wrap: false,
  title: () => t('font.title'),
  Body: FontBody,
}
