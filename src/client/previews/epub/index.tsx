/**
 * EPUB viewer: the book is a zip, so the container is read with the archive
 * helpers, the spine gives chapter order, images become data URIs, and the
 * book's stylesheet is scoped to this pane. Chapters render as blocks.
 */
import { LIMITS } from '../../../shared/limits.ts'
import { useEffect, useRef, useState } from 'react'
import { Blocks, parseMarkdownBlocks } from '../../kernel/blocks.tsx'
import type { Block } from '../../kernel/blocks.tsx'
import { fileUrl } from '../../kernel/file-url.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
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
        if (url === undefined) throw new Error('无法生成文件地址')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`读取失败（HTTP ${String(response.status)}）`)
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > MAX_BYTES) throw new Error('文件超过 64 MB 上限')
        const archive = new Uint8Array(buffer)
        const entries = listEntriesFromBuffer(archive)

        const container = await readEntryText(archive, entries, 'META-INF/container.xml')
        if (container === undefined) throw new Error('缺少 META-INF/container.xml')
        const opfPath = containerOpfPath(container)
        if (opfPath === undefined) throw new Error('container.xml 里没有 rootfile')
        const opf = await readEntryText(archive, entries, opfPath)
        if (opf === undefined) throw new Error(`找不到包文档 ${opfPath}`)
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
        if (loaded.length === 0) setDetail('书脊里没有可读章节')
      } catch (error) {
        if (!alive) return
        setStatus('error')
        setDetail(error instanceof Error ? error.message : '无法读取 EPUB')
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (status !== 'ready') {
    return <div style={PANE_FILL}>{status === 'loading' ? '正在读取电子书…' : `无法预览：${detail}`}</div>
  }

  const chapter = chapters[current]
  const total = chapters.length

  return (
    <div style={PANE_ROOT}>
      {css !== '' && <style>{css}</style>}
      <div style={barStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }}>
          {title === '' ? '电子书' : title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <button type="button" style={buttonStyle} disabled={current === 0}
            onClick={() => setCurrent(index => Math.max(0, index - 1))}>上一章</button>
          <select
            aria-label="章节"
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
            onClick={() => setCurrent(index => Math.min(total - 1, index + 1))}>下一章</button>
        </span>
      </div>
      <div className={SCOPE} style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 18px 24px', fontSize: 13 }}>
        {chapter === undefined
          ? <div style={{ color: 'var(--dsw-alias-label-tertiary)' }}>没有可显示的章节</div>
          : <Blocks blocks={chapter.blocks} />}
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const buttonStyle = {
  font: 'inherit', fontSize: 12, padding: '1px 8px', borderRadius: 5, cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

const selectStyle = {
  font: 'inherit', fontSize: 12, maxWidth: 180, padding: '1px 4px', borderRadius: 5,
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

/** What the client entry registers for this format. */
export const epubPreview: PreviewModule = {
  id: 'dsh-any-preview/epub',
  extensions: ['epub'],
  binary: ['epub'],
  load: 'renderer',
  wrap: false,
  title: () => '电子书',
  Body: EpubBody,
}
