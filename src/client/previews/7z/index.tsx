/** 7z listing; a member opens in the shared entry view, like any other archive. */
import { useEffect, useState } from 'react'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { errorText } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_FILL } from '../../kernel/layout.ts'
import {
  checkExtracted, cleanExtracted, isSupported, readSevenZip, readSevenZipEntry, streamExtracted, writeExtracted,
} from '../../kernel/sevenzip.ts'
import { openResourceAddress } from '../../runtime.ts'
import { canStream, shouldStream } from '../../../shared/sevenzip/stream.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { t } from '../../i18n.ts'
import { useLocale } from '../../useLocale.ts'
import { ArchiveList } from '../archive/ArchiveList.tsx'
import { EntryView } from '../archive/EntryView.tsx'
import { defaultTargetDir, extractedAddress } from '../archive/paths.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import type { SevenZipArchive, SevenZipEntry } from '../../../shared/sevenzip/structure.ts'

type Listing =
  | { status: 'loading' }
  | { status: 'error', detail: string }
  | { status: 'ready', archive: SevenZipArchive }

export function SevenZipBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  // The resource address is not a path: binary previews ask the document hook for
  // the absolute path and build the byte URL from that.
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const url = typeof absolutePath === 'string' ? (fileUrl(absolutePath) ?? '') : ''
  const defaultDir = typeof absolutePath === 'string' ? defaultTargetDir(absolutePath) : ''

  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [selected, setSelected] = useState<SevenZipEntry | undefined>(undefined)
  const [dir, setDir] = useState('')
  const [lastEntry, setLastEntry] = useState<SevenZipEntry | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

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

  useEffect(() => {
    if (defaultDir !== '') setDir(current => (current === '' ? defaultDir : current))
  }, [defaultDir])

  if (listing.status === 'loading') return <div style={PANE_FILL}>{t('sevenzip.loading')}</div>
  if (listing.status === 'error') return <div style={PANE_FILL}>{listing.detail}</div>

  const { archive } = listing

  const reextract = async (): Promise<void> => {
    if (lastEntry === undefined || url === '') return
    try {
      const bytes = await readSevenZipEntry(url, archive, lastEntry)
      const path = await writeExtracted(lastEntry.name, bytes, dir, true)
      const address = extractedAddress(resourceAddress, lastEntry.name, dir, defaultDir)
      const opened = address !== undefined && openResourceAddress(address)
      setNotice(opened
        ? t('archive.reextracted', { name: lastEntry.name })
        : t('archive.reextractedTo', { path }))
    } catch (error) {
      setNotice(errorText(error, 'archive.reextractFailed'))
    }
  }

  const clean = async (): Promise<void> => {
    try {
      const removed = await cleanExtracted(dir)
      setNotice(removed === 0 ? t('archive.cleanNone') : t('archive.cleaned', { count: removed }))
    } catch (error) {
      setNotice(errorText(error, 'archive.cleanFailed'))
    }
  }
  if (selected !== undefined) {
    return (
      <EntryView
        entry={selected}
        resourceAddress={resourceAddress}
        targetDir={dir}
        onTargetDir={setDir}
        defaultDir={defaultDir}
        loadBytes={() => readSevenZipEntry(url, archive, selected)}
        write={(bytes, force) => writeExtracted(selected.name, bytes, dir, force)}
        writeStream={(() => {
          const folder = archive.folders[selected.folder]
          if (folder === undefined || !canStream(folder) || !shouldStream(folder.size)) return undefined
          return (onProgress: (fraction: number) => void) => streamExtracted(url, archive, selected, dir, onProgress)
        })()}
        check={() => checkExtracted(selected.name, dir)}
        addressOf={() => extractedAddress(resourceAddress, selected.name, dir, defaultDir)}
        onOpened={() => setLastEntry(selected)}
        onBack={() => setSelected(undefined)}
      />
    )
  }

  const files = archive.entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  const supported = isSupported(archive)

  const summary = [
    t('sevenzip.summary', { count: files.length }),
    formatBytes(total),
    archive.solid ? t('sevenzip.solid') : '',
    archive.encrypted ? t('sevenzip.encrypted') : '',
  ].filter(part => part !== '').join(' · ')

  return (
    <ArchiveList
      entries={archive.entries}
      summary={summary}
      notice={notice ?? (supported ? undefined : t('sevenzip.unsupported'))}
      lastEntry={lastEntry}
      onSelect={entry => { setSelected(entry as SevenZipEntry) }}
      onReextract={() => { void reextract() }}
      onClean={() => { void clean() }}
    />
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
