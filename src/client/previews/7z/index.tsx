/** 7z listing; an entry opens in place when its coder chain is supported. */
import { useEffect, useState } from 'react'
import { errorText } from '../../kernel/errors.ts'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_FILL } from '../../kernel/layout.ts'
import { isSupported, readSevenZip, readSevenZipEntry } from '../../kernel/sevenzip.ts'
import { t } from '../../i18n.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import type { SevenZipArchive, SevenZipEntry } from '../../../shared/sevenzip/structure.ts'

/** Text entries larger than this are shown truncated. */
const MAX_PREVIEW_BYTES = 256 * 1024

type Listing =
  | { status: 'loading' }
  | { status: 'error', detail: string }
  | { status: 'ready', archive: SevenZipArchive }

/** Render one decoded entry as text. */
function previewText(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, MAX_PREVIEW_BYTES)
  const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  return text
}

export function SevenZipBody({ resourceAddress }: PreviewBodyProps) {
  const url = fileUrl(resourceAddress) ?? ''
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [open, setOpen] = useState<{ entry: SevenZipEntry, text: string, truncated: boolean } | undefined>(undefined)
  const [busy, setBusy] = useState(false)

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

  const openEntry = async (entry: SevenZipEntry): Promise<void> => {
    if (listing.status !== 'ready' || entry.directory) return
    setBusy(true)
    try {
      const bytes = await readSevenZipEntry(url, listing.archive, entry)
      setOpen({ entry, text: previewText(bytes), truncated: bytes.length > MAX_PREVIEW_BYTES })
    } catch (error) {
      setOpen({ entry, text: errorText(error, 'common.error'), truncated: false })
    } finally {
      setBusy(false)
    }
  }

  if (listing.status === 'loading') {
    return <div style={PANE_FILL}>{t('sevenzip.loading')}</div>
  }
  if (listing.status === 'error') {
    return <div style={PANE_FILL}>{listing.detail}</div>
  }

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
      status={supported ? undefined : t('sevenzip.unsupported')}
    >
      {open === undefined ? (
        <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
          <table style={TABLE}>
            <tbody>
              {archive.entries.map((entry, index) => (
                <tr key={`${String(index)}:${entry.name}`} style={entry.directory ? ROW_DIRECTORY : ROW}>
                  <td style={CELL}>
                    <button type="button" onClick={() => { void openEntry(entry) }} disabled={busy} style={entry.directory ? LINK_DISABLED : LINK}>
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
            <button type="button" onClick={() => setOpen(undefined)} style={LINK}>← {t('common.back')}</button>
            <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
              {open.entry.name}{open.truncated ? ` · ${t('sevenzip.truncated')}` : ''}
            </span>
          </div>
          <pre style={PRE}>{open.text}</pre>
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
const BACK_BAR = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', fontSize: 12,
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const
const PRE = {
  flex: '1 1 auto', overflow: 'auto', margin: 0, padding: '8px 12px', fontSize: 12,
  fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', whiteSpace: 'pre-wrap' as const,
} as const

/** Shown when listing itself fails. */
export function SevenZipError({ detail }: { readonly detail: string }) {
  return <div style={PANE_FILL}>{detail}</div>
}

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

// Referenced so the unused-export checks stay honest during development.
