/** 7z listing; an entry opens in place, or extracts so the main preview can open it. */
import { useEffect, useState } from 'react'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { errorText } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_FILL } from '../../kernel/layout.ts'
import { isSupported, readSevenZip, readSevenZipEntry, writeExtracted } from '../../kernel/sevenzip.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { t } from '../../i18n.ts'
import { chooseDirectory, openResourceAddress } from '../../runtime.ts'
import { defaultTargetDir, extractedAddress } from '../archive/paths.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import type { SevenZipArchive, SevenZipEntry } from '../../../shared/sevenzip/structure.ts'

/** Text entries larger than this are shown truncated. */
const MAX_PREVIEW_BYTES = 256 * 1024

/** Bytes shown in a hex dump before the notice. */
const MAX_HEX_BYTES = 4096

/** Extensions rendered as text. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'rst', 'yml', 'yaml',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'c', 'h', 'cpp',
  'hpp', 'rs', 'go', 'java', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'diff', 'patch',
])

/** Extensions rendered as an image. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** Lowercase extension of a member name. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** A short hex dump: offset, sixteen bytes, printable column. */
function hexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = [...bytes.subarray(offset, offset + 16)]
    const hex = row.map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
    const ascii = row.map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`)
  }
  return lines.join('\n')
}

/** What a decoded member renders as. */
type Rendered =
  | { kind: 'text', text: string, truncated: boolean }
  | { kind: 'image', url: string }
  | { kind: 'binary', text: string, truncated: boolean }
  | { kind: 'error', text: string }

/** Choose a rendering for one member. */
function renderEntry(name: string, bytes: Uint8Array): Rendered {
  const extension = extensionOf(name)
  const mime = IMAGE_MIME[extension]
  if (mime !== undefined) {
    return { kind: 'image', url: URL.createObjectURL(new Blob([bytes.slice()], { type: mime })) }
  }
  const slice = bytes.subarray(0, MAX_PREVIEW_BYTES)
  const truncated = bytes.length > MAX_PREVIEW_BYTES
  if (TEXT_EXTENSIONS.has(extension)) {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: false }).decode(slice), truncated }
  }
  return { kind: 'binary', text: hexDump(slice.subarray(0, MAX_HEX_BYTES)), truncated }
}

type Listing =
  | { status: 'loading' }
  | { status: 'error', detail: string }
  | { status: 'ready', archive: SevenZipArchive }

interface Opened {
  readonly entry: SevenZipEntry
  readonly bytes: Uint8Array
  readonly rendered: Rendered
}

export function SevenZipBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  // The resource address is not a path: binary previews ask the document hook for
  // the absolute path and build the byte URL from that.
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const url = typeof absolutePath === 'string' ? (fileUrl(absolutePath) ?? '') : ''
  const defaultDir = typeof absolutePath === 'string' ? defaultTargetDir(absolutePath) : ''

  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [opened, setOpened] = useState<Opened | undefined>(undefined)
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setListing({ status: 'loading' })
    if (url === '') {
      setListing({ status: 'error', detail: t('sevenzip.loading') })
      return () => { alive = false }
    }
    void readSevenZip(url)
      .then(archive => { if (alive) setListing({ status: 'ready', archive }) })
      .catch((error: unknown) => {
        if (alive) setListing({ status: 'error', detail: errorText(error, 'common.error') })
      })
    return () => { alive = false }
  }, [url])

  // Default the extraction directory once the archive's path is known.
  useEffect(() => {
    if (defaultDir !== '') setDir(current => (current === '' ? defaultDir : current))
  }, [defaultDir])

  const choose = async (): Promise<void> => {
    try {
      const controller = new AbortController()
      const picked = await chooseDirectory(controller.signal)
      if (picked !== undefined && picked.trim() !== '') setDir(picked)
    } catch (error) {
      setFailure(errorText(error, 'archive.chooseFailed'))
    }
  }

  const extract = async (): Promise<void> => {
    if (opened === undefined) return
    if (dir.trim() === '') {
      setFailure(t('archive.dirRequired'))
      return
    }
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const path = await writeExtracted(opened.entry.name, opened.bytes, dir)
      const address = extractedAddress(resourceAddress, opened.entry.name, dir, defaultDir)
      const openedInPreview = address !== undefined && openResourceAddress(address)
      setNotice(openedInPreview
        ? t('archive.extractedOpened', { path })
        : t('archive.extractedTo', { path }))
    } catch (error) {
      setFailure(errorText(error, 'archive.extractFailed'))
    } finally {
      setBusy(false)
    }
  }

  const openEntry = async (entry: SevenZipEntry): Promise<void> => {
    if (listing.status !== 'ready' || entry.directory) return
    setBusy(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const bytes = await readSevenZipEntry(url, listing.archive, entry)
      setOpened({ entry, bytes, rendered: renderEntry(entry.name, bytes) })
    } catch (error) {
      setOpened({ entry, bytes: new Uint8Array(), rendered: { kind: 'error', text: errorText(error, 'common.error') } })
    } finally {
      setBusy(false)
    }
  }

  if (listing.status === 'loading') return <div style={PANE_FILL}>{t('sevenzip.loading')}</div>
  if (listing.status === 'error') return <div style={PANE_FILL}>{listing.detail}</div>

  const { archive } = listing
  const files = archive.entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  const supported = isSupported(archive)

  const title = [
    t('sevenzip.summary', { count: files.length }),
    formatBytes(total),
    archive.solid ? t('sevenzip.solid') : '',
    archive.encrypted ? t('sevenzip.encrypted') : '',
  ].filter(part => part !== '').join(' · ')

  return (
    <PreviewChrome
      title={<span>{title}</span>}
      status={failure ?? notice ?? (supported ? undefined : t('sevenzip.unsupported'))}
    >
      {opened === undefined ? (
        <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
          <table style={TABLE}>
            <tbody>
              {archive.entries.map((entry, index) => (
                <tr key={`${String(index)}:${entry.name}`} style={entry.directory ? ROW_DIRECTORY : ROW}>
                  <td style={CELL}>
                    <button
                      type="button"
                      onClick={() => { void openEntry(entry) }}
                      disabled={busy}
                      style={entry.directory ? LINK_DISABLED : LINK}
                    >
                      {entry.name}
                    </button>
                  </td>
                  <td style={{ ...CELL, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' }}>
                    {entry.directory ? '' : formatBytes(entry.size)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={BACK_BAR}>
            <button type="button" onClick={() => { setOpened(undefined); setNotice(undefined) }} style={LINK}>
              ← {t('common.back')}
            </button>
            <span style={NAME}>{opened.entry.name}</span>
            <span style={{ flex: '1 1 auto' }} />
            {opened.bytes.length > 0 && (
              <>
                <button type="button" onClick={() => { void extract() }} disabled={busy} style={ACTION}>
                  {t('archive.extract')}
                </button>
                <button type="button" onClick={() => { void choose() }} style={ACTION}>
                  {t('archive.chooseDir')}
                </button>
              </>
            )}
          </div>
          {opened.rendered.kind === 'text' && <pre style={PRE}>{opened.rendered.text}</pre>}
          {opened.rendered.kind === 'binary' && (
            <>
              <div style={HINT}>{t('sevenzip.binaryHint')}</div>
              <pre style={PRE}>{opened.rendered.text}</pre>
            </>
          )}
          {opened.rendered.kind === 'error' && <div style={HINT}>{opened.rendered.text}</div>}
          {opened.rendered.kind === 'image' && (
            <div style={IMAGE_WRAP}><img src={opened.rendered.url} alt={opened.entry.name} style={IMAGE} /></div>
          )}
        </div>
      )}
    </PreviewChrome>
  )
}

const TABLE = { width: '100%', borderCollapse: 'collapse' } as const
const ROW = { borderBottom: '1px solid var(--dsw-alias-border-l2)' } as const
const ROW_DIRECTORY = { ...ROW, color: 'var(--dsw-alias-label-tertiary)' } as const
const CELL = { padding: '4px 12px', fontSize: 12, fontFamily: 'var(--dsw-font-family)' } as const
const LINK = {
  font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'transparent',
  border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' as const,
} as const
const LINK_DISABLED = { ...LINK, cursor: 'default', color: 'var(--dsw-alias-label-tertiary)' } as const
const ACTION = {
  font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const
const BACK_BAR = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12,
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto', minWidth: 0,
} as const
const NAME = {
  color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0,
} as const
const HINT = { padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } as const
const PRE = {
  flex: '1 1 auto', overflow: 'auto', margin: 0, padding: '8px 12px', fontSize: 12,
  fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', whiteSpace: 'pre-wrap' as const,
} as const
const IMAGE_WRAP = { flex: '1 1 auto', overflow: 'auto', padding: 12, textAlign: 'center' as const } as const
const IMAGE = { maxWidth: '100%', imageRendering: 'auto' as const } as const

/** What the client entry registers for this format. */
export const sevenZipPreview: PreviewModule = {
  id: 'dsh-any-preview/7z',
  extensions: ['7z'],
  binary: ['7z'],
  load: 'renderer',
  wrap: false,
  title: () => t('sevenzip.title'),
  Body: SevenZipBody,
}
