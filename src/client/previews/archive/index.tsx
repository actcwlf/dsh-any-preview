/**
 * Archive listing: zip through its central directory (ranged reads when the
 * size is known, whole-file otherwise), tar and tar.gz through the whole file
 * (gzip inflate is native).
 *
 * Listing only — extracting an entry is a later step.
 */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { t } from '../../i18n.ts'
import { errorText, PreviewError } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_FILL } from '../../kernel/layout.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { chooseDirectory, openResourceAddress } from '../../runtime.ts'
import { csvPreview } from '../csv/index.tsx'
import { diffPreview } from '../diff/index.tsx'
import { emlPreview } from '../eml/index.tsx'
import { fontPreview } from '../font/index.tsx'
import { jsonlPreview } from '../jsonl/index.tsx'
import { logPreview } from '../log/index.tsx'
import { MAX_ENTRIES, decodeText } from '../../../shared/zip/parse.ts'
import type { ArchiveEntry } from '../../../shared/zip/parse.ts'
import { listTarEntries, listZipEntries, readEntryBytesFromUrl } from '../../kernel/zip.ts'
import { ArchiveList } from './ArchiveList.tsx'
import { EntryView } from './EntryView.tsx'
import { defaultTargetDir, extractedAddress } from './paths.ts'

/** One request to the extraction route; `action` selects extract, check or clean. */
async function postExtract<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL('api/any-preview/extract', document.baseURI), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status === 404) {
    throw new PreviewError('archive.routeMissing')
  }
  if (!response.ok) throw new Error((await response.text()) || `HTTP ${String(response.status)}`)
  return await response.json() as T
}

export function ArchiveBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const { meta, absolutePath, version } = useDocument(content, resourceAddress, useResource)
  const size = meta?.size ?? 0
  const [entries, setEntries] = useState<ArchiveEntry[]>([])
  const [selected, setSelected] = useState<ArchiveEntry | undefined>(undefined)
  const [lastEntry, setLastEntry] = useState<ArchiveEntry | undefined>(undefined)
  const [barNotice, setBarNotice] = useState<string | undefined>(undefined)
  const [dir, setDir] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')

  const url = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const defaultDir = typeof absolutePath === 'string' ? defaultTargetDir(absolutePath) : ''
  const name = typeof absolutePath === 'string' ? absolutePath.replaceAll('\\', '/').split('/').pop() ?? '' : ''
  const lower = name.toLowerCase()

  useEffect(() => {
    if (url === undefined) return
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const list = lower.endsWith('.zip')
          ? await listZipEntries(url, size)
          : await listTarEntries(url, size)
        if (!alive) return
        setEntries(list)
        setStatus('ready')
      } catch (error) {
        if (!alive) return
        setStatus('error')
        setDetail(errorText(error, 'archive.readFailed'))
      }
    })()
    return () => { alive = false }
  }, [url, size, lower])

  if (status !== 'ready') {
    return (
      <div style={PANE_FILL}>
        {status === 'loading' ? t('archive.loading') : t('common.error', { detail })}
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
      setBarNotice(result.removed === 0 ? t('archive.cleanNone') : t('archive.cleaned', { count: result.removed }))
    } catch (error) {
      setBarNotice(errorText(error, 'archive.cleanFailed'))
    }
  }

  // Re-extract the member opened last: once the file itself is previewed by the
  // standard renderer, this is the only place left for that affordance.
  const reextract = async (): Promise<void> => {
    if (absolutePath === undefined || lastEntry === undefined) return
    const dir = defaultTargetDir(absolutePath)
    try {
      const result = await postExtract<{ path: string }>({
        archive: absolutePath,
        entry: lastEntry.name,
        targetDir: dir,
        force: true,
      })
      const address = extractedAddress(resourceAddress, lastEntry.name, dir, dir)
      const opened = address !== undefined && openResourceAddress(address)
      setBarNotice(opened ? t('archive.reextracted', { name: lastEntry.name }) : t('archive.reextractedTo', { path: result.path }))
    } catch (error) {
      setBarNotice(errorText(error, 'archive.reextractFailed'))
    }
  }

  if (selected !== undefined) {
    return (
      <EntryView
      entry={selected}
      resourceAddress={resourceAddress}
      targetDir={dir}
      onTargetDir={setDir}
      defaultDir={defaultTargetDir(absolutePath ?? '')}
      loadBytes={() => url === undefined
        ? Promise.reject(new Error('archive has no readable url'))
        : readEntryBytesFromUrl(url, selected)}
      write={(_bytes, force) => postExtract<{ path: string }>({
        archive: absolutePath, entry: selected.name, targetDir: dir, force,
      }).then(result => result.path)}
      check={() => postExtract<{ exists: boolean, path: string | null }>({
        action: 'check', entry: selected.name, targetDir: dir,
      }).then(result => (result.exists ? result.path ?? undefined : undefined))}
      addressOf={() => extractedAddress(resourceAddress, selected.name, dir, defaultTargetDir(absolutePath ?? ''))}
      onOpened={() => setLastEntry(selected)}
      onBack={() => setSelected(undefined)}
    />    )
  }

  return (
    <ArchiveList
      entries={entries}
      summary={`${t('archive.summary', { count: entries.length.toLocaleString('en-US'), total: formatBytes(total) })}${entries.length >= MAX_ENTRIES ? ` · ${t('archive.limitReached')}` : ''}`}
      notice={barNotice}
      lastEntry={lastEntry}
      onSelect={entry => setSelected(entry as ArchiveEntry)}
      onReextract={() => { void reextract() }}
      onClean={() => { void clean() }}
    />
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
  title: () => t('archive.title'),
  Body: ArchiveBody,
}
