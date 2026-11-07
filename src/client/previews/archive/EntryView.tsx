/**
 * One archive member, shared by every container format.
 *
 * Zip and 7z differ only in how bytes are obtained and how they reach disk; the
 * panel, the states and the wording are the same. Callers pass those two
 * operations in, so a new container needs no new UI.
 */
import { useEffect, useState } from 'react'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { CHROME_CONTROL } from '../../kernel/ui.ts'
import { contentModuleFor } from '../../kernel/content-modules.ts'
import { errorText } from '../../kernel/errors.ts'
import { formatBytes } from '../../kernel/format.ts'
import { t } from '../../i18n.ts'
import { useLocale } from '../../useLocale.ts'
import { chooseDirectory, openResourceAddress } from '../../runtime.ts'
import type { ReactNode } from 'react'

/** The fields this view needs from an archive entry. */
export interface EntryLike {
  readonly name: string
  readonly size: number
  readonly directory: boolean
}

/** Everything a container has to supply. */
export interface EntryViewProps {
  readonly entry: EntryLike
  /** Address of the archive: used to build the extracted file's address. */
  readonly resourceAddress: string
  /** Extraction directory, owned by the parent so it survives back-and-forth. */
  readonly targetDir: string
  readonly onTargetDir: (dir: string) => void
  /** Default directory beside the archive, for address building. */
  readonly defaultDir: string
  /** Read this member's bytes. */
  readonly loadBytes: () => Promise<Uint8Array>
  /** Write bytes to `targetDir`; returns the path written. */
  readonly write: (bytes: Uint8Array, force: boolean) => Promise<string>
  /** Streaming write for members too large to hold; wins over write when present. */
  readonly writeStream?: (onProgress: (fraction: number) => void) => Promise<string>
  /** Whether an earlier extraction exists. */
  readonly check: () => Promise<string | undefined>
  /** Address of the written file, when it can be opened by the main preview. */
  readonly addressOf: (path: string) => string | undefined
  readonly onOpened?: () => void
  readonly onBack: () => void
}

/** Bytes shown in a hex dump before the notice. */
const MAX_HEX_BYTES = 4096

/** Text longer than this is truncated when shown inline. */
const MAX_TEXT_BYTES = 256 * 1024

/** A short hex dump: offset, sixteen bytes, printable column. */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = [...bytes.subarray(offset, offset + 16)]
    const hex = row.map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ')
    const ascii = row.map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('')
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`)
  }
  return lines.join('\n')
}

/** How much of the buffer looks like text, so binaries are not shown as mojibake. */
function looksTextual(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096)
  let control = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 0x20 || byte === 0x7f) control += 1
  }
  return sample.length === 0 || control / sample.length < 0.05
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready', bytes: Uint8Array }
  | { status: 'error', message: string }

export function EntryView(props: EntryViewProps) {
  useLocale()
  const { entry, targetDir, onTargetDir, defaultDir, loadBytes, write, check, addressOf, onOpened, onBack } = props
  const module = contentModuleFor(entry.name)

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [extracting, setExtracting] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [existing, setExisting] = useState<string | undefined>(undefined)
  const [autoOpened, setAutoOpened] = useState(false)
  const [hexView, setHexView] = useState(false)
  const [progress, setProgress] = useState<number | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setLoaded({ status: 'loading' })
    void loadBytes()
      .then(bytes => { if (alive) setLoaded({ status: 'ready', bytes }) })
      .catch((error: unknown) => {
        if (alive) setLoaded({ status: 'error', message: errorText(error, 'archive.entryFailed') })
      })
    return () => { alive = false }
    // loadBytes is stable per entry in both callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.name])

  // A copy from an earlier visit reopens itself: asking again is pure friction.
  useEffect(() => {
    let alive = true
    void check()
      .then((path) => {
        if (!alive) return
        setExisting(path)
        if (path !== undefined && addressOf(path) !== undefined) {
          if (!autoOpened) {
            setAutoOpened(true)
            onOpened?.()
            openResourceAddress(addressOf(path) ?? '')
          }
        }
      })
      .catch(() => { /* the panel still offers extraction */ })
    return () => { alive = false }
  }, [entry.name, targetDir, addressOf, onOpened, autoOpened, check])

  const choose = async (): Promise<void> => {
    setFailure(undefined)
    try {
      const chosen = await chooseDirectory(new AbortController().signal)
      if (chosen !== undefined && chosen.trim() !== '') onTargetDir(chosen)
    } catch (error) {
      setFailure(errorText(error, 'archive.chooseFailed'))
    }
  }

  const extract = async (force = false): Promise<void> => {
    if (targetDir.trim() === '') {
      setFailure(t('archive.dirRequired'))
      return
    }
    setExtracting(true)
    setFailure(undefined)
    setNotice(undefined)
    try {
      const path = props.writeStream !== undefined && loaded.status !== 'ready'
        ? await props.writeStream(fraction => setProgress(fraction))
        : await write(loaded.status === 'ready' ? loaded.bytes : new Uint8Array(), force)
      setExisting(path)
      onOpened?.()
      const address = addressOf(path)
      const opened = address !== undefined && openResourceAddress(address)
      setNotice(opened
        ? t('archive.extractedOpened', { path })
        : t('archive.extractedTo', { path }))
    } catch (error) {
      setFailure(errorText(error, 'archive.extractFailed'))
    } finally {
      setExtracting(false)
    }
  }

  const panel = (
    <div style={PANEL}>
      <div style={{ color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 }}>
        {loaded.status === 'error' ? loaded.message : t('archive.needsExtract')}
      </div>
      <div style={ROW}>
        <input
          value={targetDir}
          onChange={event => onTargetDir(event.target.value)}
          aria-label={t('archive.dirLabel')}
          style={PATH_INPUT}
        />
        <button type="button" onClick={() => { void choose() }} style={SMALL}>{t('common.choose')}</button>
        <button type="button" onClick={() => { void extract() }} disabled={extracting} style={SMALL}>
          {extracting ? t('archive.extracting') : t('archive.extractOpen')}
        </button>
        <button type="button" onClick={() => setHexView(true)} style={SMALL}>{t('archive.viewHex')}</button>
      </div>
      {notice !== undefined && <div style={NOTE}>{notice}</div>}
      {progress !== undefined && <div style={NOTE}>{Math.round(progress * 100)}%</div>}
      {failure !== undefined && <div style={FAIL}>{failure}</div>}
    </div>
  )

  const extractedNote = (
    <div style={PANEL}>
      <div>{notice ?? t('archive.openedNote')}</div>
      <div style={PATH_TEXT}>{existing}</div>
      <div style={ROW}>
        <button type="button" onClick={() => { void extract(true) }} style={SMALL}>
          {extracting ? t('archive.extracting') : t('archive.reextract', { name: entry.name })}
        </button>
      </div>
      {failure !== undefined && <div style={FAIL}>{failure}</div>}
    </div>
  )

  let body: ReactNode
  if (loaded.status === 'loading') {
    body = <div style={LOADING}>{t('archive.extracting')}</div>
  } else if (loaded.status === 'error') {
    body = existing !== undefined ? extractedNote : panel
  } else if (module !== undefined && module.load === 'bytes-complete') {
    body = <module.Body content={{ kind: 'bytes', data: loaded.bytes }} resourceAddress="" wrap={false} />
  } else if (module !== undefined && looksTextual(loaded.bytes)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(loaded.bytes.subarray(0, MAX_TEXT_BYTES))
    body = <module.Body content={{ kind: 'text', text, eof: loaded.bytes.length <= MAX_TEXT_BYTES }} resourceAddress="" wrap={false} />
  } else if (looksTextual(loaded.bytes)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(loaded.bytes.subarray(0, MAX_TEXT_BYTES))
    body = <pre style={PRE}>{text}</pre>
  } else if (hexView) {
    // Hex is a choice, not the landing state: a binary member is usually opened to
    // extract it, and the panel is where that happens.
    body = (
      <>
        <div style={PANEL}>
          <button type="button" onClick={() => setHexView(false)} style={SMALL}>{t('common.back')}</button>
          <span style={NOTE_INLINE}>{t('sevenzip.binaryHint')}</span>
        </div>
        <pre style={PRE}>{hexDump(loaded.bytes.subarray(0, MAX_HEX_BYTES))}</pre>
      </>
    )
  } else {
    body = panel
  }

  return (
    <PreviewChrome
      title={(
        <span style={BAR_LEFT}>
          <button type="button" onClick={onBack} style={BACK}>{t('common.back')}</button>
          <span style={NAME}>{entry.name}</span>
        </span>
      )}
      toolbar={<span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{formatBytes(entry.size)}</span>}
    >
      <div style={BODY_WRAP}>{body}</div>
    </PreviewChrome>
  )
}

const BAR_LEFT = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '0 1 auto' } as const
const BACK = {
  ...CHROME_CONTROL,
  padding: '0 8px',
  color: 'var(--dsw-alias-label-primary)',
  flex: '0 0 auto',
} as const
const NAME = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 } as const
const BODY_WRAP = { position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'auto' } as const
const PANEL = { padding: 12, fontSize: 12 } as const
const ROW = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const } as const
const PATH_INPUT = {
  font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 6, flex: '1 1 auto', minWidth: 120,
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
} as const
const SMALL = {
  font: 'inherit', fontSize: 12, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
  border: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const
const NOTE = { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' } as const
const FAIL = { marginTop: 8, color: 'var(--dsw-alias-state-error-primary)' } as const
const PATH_TEXT = { marginTop: 6, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' as const } as const
const NOTE_INLINE = { marginLeft: 8, color: 'var(--dsw-alias-label-tertiary)' } as const
const LOADING = { padding: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } as const
const PRE = {
  margin: 0, padding: '8px 12px', fontSize: 12,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', whiteSpace: 'pre-wrap' as const,
} as const
