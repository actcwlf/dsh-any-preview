/**
 * EPUB viewer: the book is a zip, so the container is read with the archive
 * helpers, the spine gives chapter order, and each chapter renders as blocks.
 * Images and styles from the book are not reproduced (text-level reading view).
 */
import { useEffect, useRef, useState } from 'react'
import { Blocks, parseMarkdownBlocks } from '../../kernel/blocks.tsx'
import type { Block } from '../../kernel/blocks.tsx'
import { fileUrl } from '../../kernel/file-url.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { findEocd, inflateRaw, parseZipDirectory, zipDirectoryRange, zipEntryPayload } from '../archive/parse.ts'
import type { ArchiveEntry } from '../archive/parse.ts'
import { containerOpfPath, htmlToMarkdownText, parseOpf } from './parse.ts'

/** Books are read whole; larger ones are refused rather than buffered. */
const MAX_BYTES = 64 * 1024 * 1024

/** A chapter is only read when the reader asks for it. */
const MAX_CHAPTERS = 200

export interface EpubChapter {
  readonly name: string
  readonly blocks: readonly Block[]
}

function normalize(name: string): string {
  return name.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()
}

function listEntries(archive: Uint8Array): ArchiveEntry[] {
  const eocd = findEocd(archive)
  if (eocd < 0) throw new Error('不是有效的 EPUB（缺少 ZIP 中央目录）')
  const range = zipDirectoryRange(archive, eocd)
  if (range === undefined) throw new Error('暂不支持 ZIP64 格式')
  return parseZipDirectory(archive.subarray(range.offset, range.offset + range.size))
}

async function entryBytes(archive: Uint8Array, entry: ArchiveEntry): Promise<Uint8Array> {
  const payload = zipEntryPayload(archive, entry)
  return entry.method === 8 ? inflateRaw(payload) : payload
}

function findEntry(entries: readonly ArchiveEntry[], name: string): ArchiveEntry | undefined {
  const wanted = normalize(name)
  return entries.find(entry => normalize(entry.name) === wanted)
}

async function readText(archive: Uint8Array, entries: readonly ArchiveEntry[], name: string): Promise<string | undefined> {
  const entry = findEntry(entries, name)
  if (entry === undefined) return undefined
  const bytes = await entryBytes(archive, entry)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function EpubBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const meta = useResource?.(resourceAddress)?.value
  const absolutePath = meta?.absolutePath
  const version = meta?.version
  const reported = useRef<string | undefined>(undefined)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')
  const [title, setTitle] = useState('')
  const [chapters, setChapters] = useState<EpubChapter[]>([])
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (reported.current === version) return
    reported.current = version
    content.loaded(version)
  }, [content, version])

  useEffect(() => {
    if (typeof absolutePath !== 'string') return
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const response = await fetch(fileUrl(absolutePath))
        if (!response.ok) throw new Error(`读取失败（HTTP ${String(response.status)}）`)
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength > MAX_BYTES) throw new Error('文件超过 64 MB 上限')
        const archive = new Uint8Array(buffer)
        const entries = listEntries(archive)

        const container = await readText(archive, entries, 'META-INF/container.xml')
        if (container === undefined) throw new Error('缺少 META-INF/container.xml')
        const opfPath = containerOpfPath(container)
        if (opfPath === undefined) throw new Error('container.xml 里没有 rootfile')
        const opf = await readText(archive, entries, opfPath)
        if (opf === undefined) throw new Error(`找不到包文档 ${opfPath}`)
        const packaged = parseOpf(opf, opfPath)

        const loaded: EpubChapter[] = []
        for (const name of packaged.spine.slice(0, MAX_CHAPTERS)) {
          const html = await readText(archive, entries, name)
          if (html === undefined) continue
          loaded.push({ name, blocks: parseMarkdownBlocks(htmlToMarkdownText(html)) })
        }
        if (!alive) return
        setTitle(packaged.title ?? '')
        setChapters(loaded)
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
      <div style={barStyle}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' }}>
          {title === '' ? '电子书' : title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
          <button type="button" style={buttonStyle} disabled={current === 0}
            onClick={() => setCurrent(index => Math.max(0, index - 1))}>上一章</button>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{current + 1} / {total}</span>
          <button type="button" style={buttonStyle} disabled={current >= total - 1}
            onClick={() => setCurrent(index => Math.min(total - 1, index + 1))}>下一章</button>
        </span>
      </div>
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 18px 24px', fontSize: 13 }}>
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
