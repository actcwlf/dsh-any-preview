/**
 * Archive listing: zip through its central directory (ranged reads), tar and
 * tar.gz through the whole file (gzip inflate is native).
 *
 * Listing only — extracting an entry is a later step.
 */
import { useEffect, useRef, useState } from 'react'
import { fileUrl } from '../../kernel/file-url.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'

/** tar must be read whole, so it is capped. */
const MAX_WHOLE_BYTES = 64 * 1024 * 1024

/** Enough tail to cover an archive comment plus the end-of-central-directory record. */
const TAIL_BYTES = 66_000

/** Refuse listings past this many entries. */
const MAX_ENTRIES = 5_000

interface ArchiveEntry {
  readonly name: string
  readonly size: number
  readonly directory: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]!}`
}

/** Read an inclusive byte window, working whether or not the server honours Range. */
async function readRange(url: string, start: number, end: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${String(start)}-${String(end)}` } })
  if (!response.ok && response.status !== 206) throw new Error(`读取失败（HTTP ${String(response.status)}）`)
  const buffer = await response.arrayBuffer()
  if (response.status === 200) return new Uint8Array(buffer).slice(start, end + 1)
  return new Uint8Array(buffer)
}

function readAll(url: string): Promise<Uint8Array> {
  return fetch(url).then(async (response) => {
    if (!response.ok) throw new Error(`读取失败（HTTP ${String(response.status)}）`)
    return new Uint8Array(await response.arrayBuffer())
  })
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8)
}

function u32(bytes: Uint8Array, at: number): number {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0
}

/** Parse the zip central directory into entries. */
function parseZipDirectory(directory: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let at = 0
  while (at + 46 <= directory.length && entries.length < MAX_ENTRIES) {
    if (u32(directory, at) !== 0x02014b50) break
    const flags = u16(directory, at + 8)
    const nameLength = u16(directory, at + 28)
    const extraLength = u16(directory, at + 30)
    const commentLength = u16(directory, at + 32)
    const size = u32(directory, at + 24)
    const nameBytes = directory.subarray(at + 46, at + 46 + nameLength)
    const encoding = (flags & 0x800) !== 0 ? 'utf-8' : 'utf-8'
    const name = new TextDecoder(encoding).decode(nameBytes)
    entries.push({ name, size, directory: name.endsWith('/') })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Walk tar headers (512-byte blocks, octal size fields). */
function parseTar(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let at = 0
  const decoder = new TextDecoder()
  while (at + 512 <= bytes.length && entries.length < MAX_ENTRIES) {
    const header = bytes.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const rawName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/u, '')
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/u, '')
    const name = prefix === '' ? rawName : `${prefix}/${rawName}`
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/[\0 ]+$/u, '').trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(header[156] ?? 0)
    entries.push({ name, size, directory: type === '5' || name.endsWith('/') })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

/** Decompress a gzip stream with the platform's inflate. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function listZip(url: string, size: number): Promise<ArchiveEntry[]> {
  const tailStart = Math.max(0, size - TAIL_BYTES)
  const tail = await readRange(url, tailStart, size - 1)
  // The comment length is unknown, so scan backwards for the EOCD signature.
  let eocd = -1
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (u32(tail, at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const count = u16(tail, eocd + 10)
  const directorySize = u32(tail, eocd + 12)
  const directoryOffset = u32(tail, eocd + 16)
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式')
  }
  if (count === 0) return []
  const directory = await readRange(url, directoryOffset, directoryOffset + directorySize - 1)
  return parseZipDirectory(directory)
}

async function listTar(url: string, size: number, gzipped: boolean): Promise<ArchiveEntry[]> {
  if (size > MAX_WHOLE_BYTES) throw new Error(`压缩包 ${formatBytes(size)} 超过 ${formatBytes(MAX_WHOLE_BYTES)} 上限`)
  const bytes = await readAll(url)
  const raw = gzipped || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? await gunzip(bytes) : bytes
  return parseTar(raw)
}

export function ArchiveBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const meta = useResource?.(resourceAddress)?.value
  const absolutePath = meta?.absolutePath
  const version = meta?.version
  const size = meta?.size ?? 0
  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')
  const reported = useRef<string | undefined>(undefined)

  // The list is this renderer's content: report readiness so the pane leaves
  // its loading state.
  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (reported.current === version) return
    reported.current = version
    content.loaded(version)
  }, [content, version])

  const url = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const name = typeof absolutePath === 'string' ? absolutePath.replaceAll('\\', '/').split('/').pop() ?? '' : ''
  const lower = name.toLowerCase()

  useEffect(() => {
    if (url === undefined) return
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const list = lower.endsWith('.zip')
          ? await listZip(url, size)
          : await listTar(url, size, lower.endsWith('.tgz') || lower.endsWith('.tar.gz'))
        if (!alive) return
        setEntries(list)
        setStatus('ready')
      } catch (error) {
        if (!alive) return
        setStatus('error')
        setDetail(error instanceof Error ? error.message : '无法读取压缩包')
      }
    })()
    return () => { alive = false }
  }, [url, size, lower])

  if (status !== 'ready') {
    return (
      <div style={PANE_FILL}>
        {status === 'loading' ? '正在读取压缩包…' : `无法预览：${detail}`}
      </div>
    )
  }

  const files = entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span>
          {entries.length.toLocaleString('en-US')} 个条目
          {' · '}解压后 {formatBytes(total)}
          {entries.length >= MAX_ENTRIES && ' · 已达上限'}
        </span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>仅列出内容</span>
      </div>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--dsw-font-family)', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={headerStyle}>名称</th>
              <th style={{ ...headerStyle, textAlign: 'right', width: 90 }}>大小</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={index}>
                <td style={{ ...cellStyle, color: entry.directory ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' }}>
                  {entry.name}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {entry.directory ? '' : formatBytes(entry.size)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const headerStyle = {
  position: 'sticky' as const,
  top: 0,
  padding: '5px 12px',
  textAlign: 'left' as const,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
} as const

const cellStyle = {
  padding: '4px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  whiteSpace: 'nowrap' as const,
} as const

const ARCHIVE_EXTENSIONS = ['zip', 'tar', 'tar.gz', 'tgz'] as const

/** What the client entry registers for this format. */
export const archivePreview: PreviewModule = {
  id: 'dsh-any-preview/archive',
  extensions: ARCHIVE_EXTENSIONS,
  binary: ARCHIVE_EXTENSIONS,
  load: 'renderer',
  wrap: false,
  title: () => '压缩包',
  Body: ArchiveBody,
}
