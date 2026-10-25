/**
 * Archive listing: zip through its central directory (ranged reads when the
 * size is known, whole-file otherwise), tar and tar.gz through the whole file
 * (gzip inflate is native).
 *
 * Listing only — extracting an entry is a later step.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fileUrl } from '../../kernel/file-url.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { chooseDirectory, openResourceAddress } from '../../runtime.ts'
import { csvPreview } from '../csv/index.tsx'
import { diffPreview } from '../diff/index.tsx'
import { emlPreview } from '../eml/index.tsx'
import { fontPreview } from '../font/index.tsx'
import { jsonlPreview } from '../jsonl/index.tsx'
import { logPreview } from '../log/index.tsx'
import { MAX_ENTRIES, decodeText, findEocd, inflateRaw, localDataStart, parseTar, parseZipDirectory, zipDirectoryRange } from './parse.ts'
import type { ArchiveEntry } from './parse.ts'

/** Anything read whole must fit this. */
const MAX_WHOLE_BYTES = 64 * 1024 * 1024

/** Enough tail to cover an archive comment plus the end-of-central-directory record. */
const TAIL_BYTES = 66_000

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
  if (response.status === 206) return new Uint8Array(await response.arrayBuffer())
  if (response.status === 200) {
    // The server ignored Range and sent everything.
    const whole = new Uint8Array(await response.arrayBuffer())
    return whole.subarray(start, Math.min(whole.length, end + 1))
  }
  throw new Error(`读取失败（HTTP ${String(response.status)}）`)
}

/**
 * Total size from a one-byte range. `Content-Range` carries it and, unlike
 * `Content-Length`, survives the desktop shell's forwarding proxy.
 */
async function fileSize(url: string): Promise<number | undefined> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  if (response.status !== 206) {
    await response.body?.cancel()
    return undefined
  }
  const match = /\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')
  await response.body?.cancel()
  return match === null ? undefined : Number(match[1])
}

function readAll(url: string): Promise<Uint8Array> {
  return fetch(url).then(async (response) => {
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`读取失败（HTTP ${String(response.status)}）`)
    }
    return new Uint8Array(await response.arrayBuffer())
  })
}

/** Parse the directory out of a complete archive buffer. */
function listZipFromBuffer(bytes: Uint8Array): ArchiveEntry[] {
  const eocd = findEocd(bytes)
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const range = zipDirectoryRange(bytes, eocd)
  if (range === undefined) throw new Error('暂不支持 ZIP64 格式')
  if (range.size === 0) return []
  return parseZipDirectory(bytes.subarray(range.offset, range.offset + range.size))
}

async function listZip(url: string, sizeHint: number): Promise<ArchiveEntry[]> {
  const size = sizeHint > 0 ? sizeHint : await fileSize(url)

  if (size === undefined || size <= 0) {
    const whole = await readAll(url)
    if (whole.length > MAX_WHOLE_BYTES) {
      throw new Error(`压缩包 ${formatBytes(whole.length)} 超过 ${formatBytes(MAX_WHOLE_BYTES)} 上限`)
    }
    return listZipFromBuffer(whole)
  }

  const tailStart = Math.max(0, size - TAIL_BYTES)
  const tail = await readRange(url, tailStart, size - 1)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const range = zipDirectoryRange(tail, eocd)
  if (range === undefined) throw new Error('暂不支持 ZIP64 格式')
  if (range.size === 0) return []

  const inTail = range.offset >= tailStart && range.offset + range.size <= tailStart + tail.length
  const directory = inTail
    ? tail.subarray(range.offset - tailStart, range.offset - tailStart + range.size)
    : await readRange(url, range.offset, range.offset + range.size - 1)
  return parseZipDirectory(directory)
}

/** Decompress a gzip stream with the platform's inflate. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function listTar(url: string, size: number, gzipped: boolean): Promise<ArchiveEntry[]> {
  if (size > MAX_WHOLE_BYTES) {
    throw new Error(`压缩包 ${formatBytes(size)} 超过 ${formatBytes(MAX_WHOLE_BYTES)} 上限`)
  }
  const bytes = await readAll(url)
  const raw = gzipped || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? await gunzip(bytes) : bytes
  return parseTar(raw)
}

/** Largest member expanded inline; bigger payloads stay on disk. */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024

/**
 * Read one stored or deflated member into text.
 * @param url - the archive's file URL.
 * @param entry - member to expand.
 * @returns its decoded text.
 */
async function readEntryBytes(url: string, entry: ArchiveEntry): Promise<Uint8Array> {
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`条目 ${formatBytes(entry.size)} 超过 ${formatBytes(MAX_ENTRY_BYTES)} 上限`)
  }
  const header = await readRange(url, entry.offset, entry.offset + 29)
  const dataStart = entry.offset + localDataStart(header)
  const raw = entry.compressedSize === 0
    ? new Uint8Array()
    : await readRange(url, dataStart, dataStart + entry.compressedSize - 1)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRaw(raw)
  throw new Error(`暂不支持压缩方法 ${String(entry.method)}`)
}

/** Formats this package renders from content alone, without a file address. */
const CONTENT_MODULES: readonly PreviewModule[] = [
  csvPreview, diffPreview, emlPreview, fontPreview, jsonlPreview, logPreview,
]

function contentModuleFor(name: string): PreviewModule | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = name.slice(dot + 1).toLowerCase()
  return CONTENT_MODULES.find(module => module.extensions.includes(extension))
}

/** Default extraction directory: a hidden folder beside the archive. */
export function defaultTargetDir(archivePath: string): string {
  const normalized = archivePath.replaceAll('\\', '/')
  const cut = normalized.lastIndexOf('/')
  return `${cut < 0 ? '.' : normalized.slice(0, cut)}/.dsh-any-preview`
}

/**
 * Address of an extracted member, when the archive is a session file and the
 * member landed in the default directory beside it. Anything else cannot be
 * referenced by the file resource.
 */
export function extractedAddress(
  resourceAddress: string,
  entryName: string,
  targetDir: string,
  expectedDir: string,
): string | undefined {
  const prefix = 'dsh-resource://file/session/'
  if (!resourceAddress.startsWith(prefix)) return undefined
  if (targetDir.replaceAll('\\', '/') !== expectedDir) return undefined
  const segments = resourceAddress.slice(prefix.length).split('/')
  const sessionId = segments[0]
  if (sessionId === undefined || sessionId === '') return undefined
  const relative = segments.slice(1).map(decodeURIComponent).join('/')
  const cut = relative.lastIndexOf('/')
  const directory = cut < 0 ? '' : relative.slice(0, cut)
  const name = entryName.replaceAll('\\', '/').split('/').pop() ?? entryName
  const encodedDir = directory === '' ? '' : `${directory.split('/').map(encodeURIComponent).join('/')}/`
  return `${prefix}${sessionId}/${encodedDir}.dsh-any-preview/${encodeURIComponent(name)}`
}

/** One request to the extraction route; `action` selects extract, check or clean. */
async function postExtract<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL('api/any-preview/extract', document.baseURI), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 404) {
    throw new Error('解压服务未加载：Host 半只在应用启动时加载，请重启应用后重试')
  }
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${String(response.status)}`)
  return await response.json() as T
}

/** One member: rendered by its own format when we have one, else explained. */
function EntryView({ entry, url, resourceAddress, archivePath, onBack }: {
  readonly entry: ArchiveEntry
  readonly url: string | undefined
  readonly resourceAddress: string
  readonly archivePath: string
  readonly onBack: () => void
}) {
  const module = contentModuleFor(entry.name)
  const defaultDir = defaultTargetDir(archivePath)
  const [loaded, setLoaded] = useState<{ status: 'loading' | 'ready' | 'error', bytes?: Uint8Array, text?: string, message?: string }>({ status: 'loading' })
  const [dir, setDir] = useState(defaultDir)
  const [extracting, setExtracting] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [existing, setExisting] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (url === undefined) return
    let alive = true
    setLoaded({ status: 'loading' })
    void readEntryBytes(url, entry)
      .then((bytes) => {
        if (!alive) return
        const text = module?.load === 'bytes-complete' ? undefined : decodeText(bytes)
        setLoaded({ status: 'ready', bytes, text })
      })
      .catch((error: unknown) => {
        if (alive) setLoaded({ status: 'error', message: error instanceof Error ? error.message : '无法读取条目' })
      })
    return () => { alive = false }
  }, [url, entry, module])

  // Look for a copy from an earlier visit, so reopening does not ask again.
  useEffect(() => {
    let alive = true
    void postExtract<{ exists: boolean, path: string | null }>({ action: 'check', entry: entry.name, targetDir: dir })
      .then((result) => { if (alive) setExisting(result.exists ? result.path ?? undefined : undefined) })
      .catch(() => { /* route not loaded yet: the panel still offers extraction */ })
    return () => { alive = false }
  }, [entry.name, dir])

  const choose = async (): Promise<void> => {
    setFailure(undefined)
    try {
      const chosen = await chooseDirectory(new AbortController().signal)
      if (chosen !== undefined) setDir(chosen)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '无法选择目录')
    }
  }

  const extract = async (force = false): Promise<void> => {
    setExtracting(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const result = await postExtract<{ path: string }>({
        archive: archivePath,
        entry: entry.name,
        targetDir: dir,
        force,
      })
      setExisting(result.path)
      const address = extractedAddress(resourceAddress, entry.name, dir, defaultDir)
      setNotice(address !== undefined && openResourceAddress(address)
        ? `已解压并在主预览中打开：${result.path}`
        : `已解压到 ${result.path}，可在文件树中打开`)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : '解压失败')
    } finally {
      setExtracting(false)
    }
  }

  const openExisting = (): void => {
    const address = extractedAddress(resourceAddress, entry.name, dir, defaultDir)
    if (address !== undefined && openResourceAddress(address)) {
      setNotice('已在主预览中打开')
      return
    }
    setNotice(`文件在 ${existing ?? dir}，可在文件树中打开`)
  }

  const panel = (
    <div style={panelStyle}>
      <div style={{ color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 }}>
        {loaded.status === 'error'
          ? loaded.message
          : '此类型需解压后用主预览查看。'}
      </div>
      {existing !== undefined
        ? (
            <>
              <div style={{ marginBottom: 8, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' }}>
                已解压：{existing}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" onClick={openExisting} style={smallButtonStyle}>在主预览打开</button>
                <button type="button" onClick={() => { void extract(true) }} disabled={extracting} style={smallButtonStyle}>
                  {extracting ? '解压中…' : '重新解压'}
                </button>
              </div>
            </>
          )
        : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={dir}
                onChange={event => setDir(event.target.value)}
                aria-label="解压目录"
                style={pathInputStyle}
              />
              <button type="button" onClick={() => { void choose() }} style={smallButtonStyle}>选择…</button>
              <button type="button" onClick={() => { void extract() }} disabled={extracting} style={smallButtonStyle}>
                {extracting ? '解压中…' : '解压并打开'}
              </button>
            </div>
          )}
      {notice !== undefined && <div style={{ marginTop: 8, color: 'var(--dsw-alias-label-secondary)' }}>{notice}</div>}
      {failure !== undefined && <div style={{ marginTop: 8, color: 'rgb(248, 81, 73)' }}>{failure}</div>}
    </div>
  )

  let body: ReactNode
  if (loaded.status === 'loading') {
    body = <div style={{ padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>正在解压…</div>
  } else if (loaded.status === 'error') {
    body = panel
  } else if (module !== undefined && module.load === 'bytes-complete' && loaded.bytes !== undefined) {
    body = <module.Body content={{ kind: 'bytes', data: loaded.bytes }} resourceAddress="" wrap={false} />
  } else if (module !== undefined && loaded.text !== undefined) {
    body = <module.Body content={{ kind: 'text', text: loaded.text, eof: true }} resourceAddress="" wrap={false} />
  } else if (loaded.text !== undefined) {
    body = <pre style={preStyle}>{loaded.text}</pre>
  } else {
    body = panel
  }

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <button type="button" onClick={onBack} style={backStyle}>← 返回</button>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
        </span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{formatBytes(entry.size)}</span>
      </div>
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        {body}
      </div>
    </div>
  )
}

export function ArchiveBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const meta = useResource?.(resourceAddress)?.value
  const absolutePath = meta?.absolutePath
  const version = meta?.version
  const size = meta?.size ?? 0
  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [selected, setSelected] = useState<ArchiveEntry | undefined>(undefined)
  const [cleanNotice, setCleanNotice] = useState<string | undefined>(undefined)
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

  const clean = async (): Promise<void> => {
    if (absolutePath === undefined) return
    try {
      const result = await postExtract<{ removed: number }>({
        action: 'clean',
        targetDir: defaultTargetDir(absolutePath),
      })
      setCleanNotice(result.removed === 0 ? '没有需要清理的解压文件' : `已清理 ${String(result.removed)} 个解压文件`)
    } catch (error) {
      setCleanNotice(error instanceof Error ? error.message : '清理失败')
    }
  }

  if (selected !== undefined) {
    return (
      <EntryView
        entry={selected}
        url={url}
        resourceAddress={resourceAddress}
        archivePath={absolutePath ?? ''}
        onBack={() => setSelected(undefined)}
      />
    )
  }

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span>
          {entries.length.toLocaleString('en-US')} 个条目
          {' · '}解压后 {formatBytes(total)}
          {entries.length >= MAX_ENTRIES && ' · 已达上限'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--dsw-alias-label-tertiary)' }}>
          <span>{cleanNotice ?? '点击条目预览内容'}</span>
          {absolutePath !== undefined && (
            <button type="button" onClick={() => { void clean() }} style={smallButtonStyle}>清理解压</button>
          )}
        </span>
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
              <tr
                key={index}
                onClick={entry.directory ? undefined : () => setSelected(entry)}
                style={{ cursor: entry.directory ? 'default' : 'pointer' }}
              >
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

const backStyle = {
  font: 'inherit', fontSize: 12, padding: '1px 8px', borderRadius: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const preStyle = {
  margin: 0,
  padding: '10px 14px',
  fontFamily: 'var(--dsw-font-markdown-code-block, monospace)',
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--dsw-alias-label-primary)',
} as const

const panelStyle = {
  padding: '12px 14px',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
} as const

const pathInputStyle = {
  font: 'inherit',
  fontSize: 12,
  padding: '2px 8px',
  flex: '1 1 240px',
  minWidth: 180,
  borderRadius: 6,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

const smallButtonStyle = {
  font: 'inherit',
  fontSize: 12,
  padding: '2px 10px',
  borderRadius: 6,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
  flex: '0 0 auto',
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
