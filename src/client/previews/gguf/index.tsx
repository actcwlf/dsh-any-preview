/** GGUF inspector: architecture, quantization and tensor shapes of a model file. */
import { useEffect, useState } from 'react'
import { LIMITS } from '../../../shared/limits.ts'
import { t } from '../../i18n.ts'
import { useLocale } from '../../useLocale.ts'
import { PreviewError } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { DataTable, KeyValueTable, Note, Summary } from '../../kernel/inspect.tsx'
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { TEXT } from '../../kernel/ui.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { readRange } from '../../kernel/zip.ts'
import { parseGguf } from './parse.ts'
import type { GgufHeader } from './parse.ts'

/** Header windows tried in turn; a model's metadata is usually a few MB. */
const WINDOWS = [256 * 1024, 2 * 1024 * 1024, LIMITS.ggufWindow]

/** Tensors listed before the table becomes noise. */
const SHOWN_TENSORS = 300

/**
 * Read as much of the header as the parse needs.
 * @param url - file URL.
 * @returns the parsed header.
 */
async function readHeader(url: string): Promise<GgufHeader> {
  let lastError: unknown
  for (const size of WINDOWS) {
    const head = await readRange(url, 0, size - 1)
    try {
      return parseGguf(head)
    } catch (error) {
      lastError = error
    }
    // The file is shorter than the window: growing it cannot help.
    if (head.length < size) break
  }
  if (lastError instanceof PreviewError) throw lastError
  throw new PreviewError('gguf.parseFailed')
}

function kvOf(header: GgufHeader, key: string): string | undefined {
  return header.kv.find(entry => entry.key === key)?.value
}

export function GgufBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error', header?: GgufHeader, detail?: string }>({ status: 'loading' })

  useEffect(() => {
    if (absolutePath === undefined) return
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const url = fileUrl(absolutePath)
        if (url === undefined) throw new PreviewError('common.fileUrl')
        const header = await readHeader(url)
        if (!alive) return
        setState({ status: 'ready', header })
      } catch (error) {
        if (!alive) return
        const detail = error instanceof PreviewError
          ? t(error.key, error.params)
          : t('gguf.parseFailed')
        setState({ status: 'error', detail })
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (state.status !== 'ready' || state.header === undefined) {
    const failed = state.status === 'error'
    return (
      <PreviewState
        kind="GGUF"
        title={failed ? t('common.failed') : t('gguf.loading')}
        message={failed ? t('common.error', { detail: state.detail ?? '' }) : t('gguf.loading')}
        tone={failed ? 'critical' : 'normal'}
      />
    )
  }

  const header = state.header
  const shown = header.tensors.slice(0, SHOWN_TENSORS)

  return (
    <PreviewChrome
      kind="GGUF"
      title={<span>{`v${String(header.version)}`}</span>}
      status={header.kvCount > header.kv.length ? t('metadata.count', { count: header.kvCount, shown: header.kv.length }) : undefined}
    >
      <Summary fields={[
        { label: t('common.version'), value: String(header.version) },
        { label: t('common.architecture'), value: kvOf(header, 'general.architecture') ?? '' },
        { label: t('common.name'), value: kvOf(header, 'general.name') ?? '' },
        { label: t('common.tensors'), value: header.tensorCount.toLocaleString('en-US') },
        { label: t('common.metadata'), value: t('count.items', { count: header.kvCount.toLocaleString('en-US') }) },
        ...header.quantizations.slice(0, 3).map(([type, count]) => ({ label: type, value: t('count.units', { count }) })),
      ]} />
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '0 12px 16px' }}>
        <section style={{ marginTop: 10 }}>
          <div style={sectionTitle}>{t('common.metadata')}</div>
          <KeyValueTable entries={header.kv.map(entry => [entry.key, entry.value])} />
        </section>
        <section style={{ marginTop: 14 }}>
          <div style={sectionTitle}>{t('common.tensors')}</div>
          <DataTable
            columns={[t('common.name'), t('common.type'), t('common.dims'), t('common.params')]}
            right={[3]}
            rows={shown.map(tensor => [
              tensor.name,
              tensor.type,
              tensor.dims.join(' × '),
              tensor.params.toLocaleString('en-US'),
            ])}
          />
          {header.tensorCount > shown.length && (
            <Note>{t('tensors.count', { count: header.tensorCount, shown: shown.length })}</Note>
          )}
        </section>
      </div>
    </PreviewChrome>
  )
}

const sectionTitle = {
  fontSize: TEXT.caption.fontSize, lineHeight: TEXT.caption.lineHeight,
  fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)',
  textTransform: 'uppercase' as const, letterSpacing: 0.4, marginBottom: 4,
} as const

/** What the client entry registers for this format. */
export const ggufPreview: PreviewModule = {
  id: 'dsh-any-preview/gguf',
  extensions: ['gguf'],
  binary: ['gguf'],
  load: 'renderer',
  wrap: false,
  title: () => 'GGUF',
  Body: GgufBody,
}