/**
 * EPUB viewer: the book is a zip, so the container is read with the archive
 * helpers, the spine gives chapter order, images become data URIs, and the
 * book's stylesheet is scoped to this pane. Chapters render as blocks.
 */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { CHROME_CONTROL } from '../../kernel/ui.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PreviewError, errorText } from '../../kernel/errors.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { useEffect, useRef, useState } from 'react'
import { Blocks, parseMarkdownBlocks } from '../../kernel/blocks.tsx'
import type { Block } from '../../kernel/blocks.tsx'
import { fileUrl } from '../../kernel/file-url.ts'
import { PANE_FILL } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { entryBytes, findEntry, listEntriesFromBuffer, normalizeEntryName, readEntryText } from '../../kernel/zip.ts'
import type { ArchiveEntry } from '../../../shared/zip/parse.ts'
import { containerOpfPath, htmlToMarkdownText, imageMimeType, parseNav, parseNcx, parseOpf, resolveHref, scopeCss } from './parse.ts'
import type { TocEntry } from './parse.ts'

/** Books are read whole; larger ones are refused rather than buffered. */
const MAX_BYTES = LIMITS.epubBook

/** A book with more chapters than this is truncated rather than frozen. */
const MAX_CHAPTERS = LIMITS.epubChapters

/** Container class the book's stylesheet is scoped to. */
const SCOPE = 'dsh-epub-body'

export interface EpubChapter {
  readonly name: string
  readonly title: string
  readonly blocks: readonly Block[]
}

function dirOf(name: string): string {
  const cut = name.lastIndexOf('/')
  return cut < 0 ? '' : name.slice(0, cut)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * Resolve the images a chapter references into data URIs.
 * @returns a lookup keyed by the original `src` attribute.
 */
async function chapterImages(
  archive: Uint8Array,
  entries: readonly ArchiveEntry[],
  chapterName: string,
  html: string,
): Promise<(src: string) => string | undefined> {
  const resolved = new Map<string, string>()
  const base = dirOf(chapterName)
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    const raw = (match[1] ?? match[2] ?? '').trim()
    if (raw === '' || resolved.has(raw)) continue
    const target = resolveHref(base, raw)
    const mime = imageMimeType(target)
    if (mime === undefined) continue
    const entry = findEntry(entries, target)
    if (entry === undefined) continue
    resolved.set(raw, `data:${mime};base64,${toBase64(await entryBytes(archive, entry))}`)
  }
  return src => resolved.get(src.trim())
}

export function EpubBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')
  const [title, setTitle] = useState('')
  const [chapters, setChapters] = useState<EpubChapter[]>([])
  const [css, setCss] = useState('')
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (typeof absolutePath !== 'string') return
    // Captured before the async body: narrowing does not survive into a closure.
    const path = absolutePath
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const url = fileUrl(path)
        if (url === undefined) throw new PreviewError('common.fileUrl')
        const response = await fetch(url)
        if (!response.ok) throw new PreviewError('common.httpError', { status: response.status })
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > MAX_BYTES) throw new PreviewError('epub.tooLarge', { limit: formatBytes(MAX_BYTES) })
        const archive = new Uint8Array(buffer)
        const entries = listEntriesFromBuffer(archive)

        const container = await readEntryText(archive, entries, 'META-INF/container.xml')
        if (container === undefined) throw new PreviewError('epub.missingContainer')
        const opfPath = containerOpfPath(container)
        if (opfPath === undefined) throw new PreviewError('epub.noRootfile')
        const opf = await readEntryText(archive, entries, opfPath)
        if (opf === undefined) throw new PreviewError('epub.missingOpf', { path: opfPath })
        const packaged = parseOpf(opf, opfPath)

        let toc: TocEntry[] = []
        if (packaged.nav !== undefined) {
          toc = parseNav((await readEntryText(archive, entries, packaged.nav)) ?? '', dirOf(packaged.nav))
        } else if (packaged.ncx !== undefined) {
          toc = parseNcx((await readEntryText(archive, entries, packaged.ncx)) ?? '', dirOf(packaged.ncx))
        }
        const titleOf = (name: string): string =>
          toc.find(entry => normalizeEntryName(entry.href) === normalizeEntryName(name))?.title
          ?? name.replaceAll('\\', '/').split('/').pop()
          ?? name

        const loaded: EpubChapter[] = []
        const inlineCss: string[] = []
        for (const name of packaged.spine.slice(0, MAX_CHAPTERS)) {
          const html = await readEntryText(archive, entries, name)
          if (html === undefined) continue
          for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) inlineCss.push(style[1] ?? '')
          const resolveImage = await chapterImages(archive, entries, name, html)
          loaded.push({ name, title: titleOf(name), blocks: parseMarkdownBlocks(htmlToMarkdownText(html, resolveImage)) })
        }

        let linked = ''
        for (const href of packaged.stylesheets) linked += (await readEntryText(archive, entries, href)) ?? ''
        const scoped = scopeCss(`${linked}\n${inlineCss.join('\n')}`, SCOPE)

        if (!alive) return
        setTitle(packaged.title ?? '')
        setChapters(loaded)
        setCss(scoped)
        setCurrent(0)
        setStatus(loaded.length === 0 ? 'error' : 'ready')
        if (loaded.length === 0) setDetail(t('epub.noChapters'))
      } catch (error) {
        if (!alive) return
        setStatus('error')
        setDetail(errorText(error, 'epub.readFailed'))
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (status !== 'ready') {
    return <div style={PANE_FILL}>{status === 'loading' ? t('epub.loading') : t('common.error', { detail })}</div>
  }

  const chapter = chapters[current]
  const total = chapters.length

  return (
    <PreviewChrome
      title={title === '' ? t('epub.title') : title}
      toolbar={(
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <button type="button" style={buttonStyle} disabled={current === 0}
            onClick={() => setCurrent(index => Math.max(0, index - 1))}>{t('epub.prev')}</button>
          <select
            aria-label={t('epub.chapter')}
            value={current}
            onChange={event => setCurrent(Number(event.target.value))}
            style={selectStyle}
          >
            {chapters.map((item, index) => (
              <option key={index} value={index}>{item.title}</option>
            ))}
          </select>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{current + 1} / {total}</span>
          <button type="button" style={buttonStyle} disabled={current >= total - 1}
            onClick={() => setCurrent(index => Math.min(total - 1, index + 1))}>{t('epub.next')}</button>
        </span>
      )}
    >
      {css !== '' && <style>{css}</style>}
      <div className={SCOPE} style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 18px 24px', fontSize: 13 }}>
        {chapter === undefined
          ? <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('epub.noChapter')}</div>
          : <Blocks blocks={chapter.blocks} />}
      </div>
    </PreviewChrome>
  )
}

const buttonStyle = {
  ...CHROME_CONTROL,
  flex: '0 0 auto',
} as const

const selectStyle = {
  ...CHROME_CONTROL,
  maxWidth: 180,
  padding: '0 8px',
  background: 'var(--dsw-alias-bg-layer-2)',
} as const

/** What the client entry registers for this format. */
export const epubPreview: PreviewModule = {
  id: 'dsh-any-preview/epub',
  extensions: ['epub'],
  binary: ['epub'],
  load: 'renderer',
  wrap: false,
  title: () => t('epub.title'),
  Body: EpubBody,
}
