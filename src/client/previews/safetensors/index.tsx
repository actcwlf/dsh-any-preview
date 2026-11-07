/** SafeTensors header inspector: what tensors a shard holds, and their dtypes. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { useEffect, useState } from 'react'
import { t } from '../../i18n.ts'
import { useLocale } from '../../useLocale.ts'
import { PreviewError } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { DataTable, KeyValueTable, Note, Summary } from '../../kernel/inspect.tsx'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { readRange } from '../../kernel/zip.ts'
import { MAX_HEADER_BYTES, parseHeaderJson, readHeaderLength } from './parse.ts'
import type { SafeTensorsHeader } from './parse.ts'

/** Tensors listed before the table becomes noise. */
const SHOWN_TENSORS = 500

export function SafeTensorsBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error', header?: SafeTensorsHeader, detail?: string }>({ status: 'loading' })

  useEffect(() => {
    if (absolutePath === undefined) return
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const url = fileUrl(absolutePath)
        if (url === undefined) throw new PreviewError('common.fileUrl')
        const length = readHeaderLength(await readRange(url, 0, 7))
        if (length === undefined) throw new PreviewError('safetensors.tooShort')
        if (length === 0 || length > MAX_HEADER_BYTES) {
          throw new PreviewError('safetensors.headerSize', {
            size: formatBytes(length),
            limit: formatBytes(MAX_HEADER_BYTES),
          })
        }
        const raw = await readRange(url, 8, 8 + length - 1)
        const header = parseHeaderJson(new TextDecoder('utf-8', { fatal: false }).decode(raw), length)
        if (!alive) return
        setState({ status: 'ready', header })
      } catch (error) {
        if (!alive) return
        const detail = error instanceof PreviewError
          ? t(error.key, error.params)
          : t('safetensors.parseFailed')
        setState({ status: 'error', detail })
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (state.status !== 'ready' || state.header === undefined) {
    const failed = state.status === 'error'
    return (
      <PreviewState
        kind="SAFETENSORS"
        title={failed ? t('common.failed') : t('safetensors.loading')}
        message={failed ? t('common.error', { detail: state.detail ?? '' }) : t('safetensors.loading')}
        tone={failed ? 'critical' : 'normal'}
      />
    )
  }

  const header = state.header
  const shown = header.tensors.slice(0, SHOWN_TENSORS)

  return (
    <PreviewChrome
      kind="SAFETENSORS"
      title={<span>{t('common.tensors') + ' ' + header.tensors.length.toLocaleString('en-US')}</span>}
      status={header.tensors.length > shown.length ? t('tensors.count', { count: header.tensors.length, shown: shown.length }) : undefined}
    >
      <Summary fields={[
        { label: t('common.tensors'), value: header.tensors.length.toLocaleString('en-US') },
        { label: t('common.params'), value: header.totalParams.toLocaleString('en-US') },
        { label: t('common.header'), value: formatBytes(header.headerBytes) },
        ...header.dtypes.map(([dtype, count]) => ({ label: dtype, value: t('count.units', { count }) })),
      ]} />
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '0 12px 16px' }}>
        {header.metadata.length > 0 && (
          <section style={{ marginTop: 10 }}>
            <div style={sectionTitle}>{t('common.metadata')}</div>
            <KeyValueTable entries={header.metadata} />
          </section>
        )}
        <section style={{ marginTop: 10 }}>
          <div style={sectionTitle}>{t('common.tensors')}</div>
          <DataTable
            columns={[t('common.name'), 'dtype', t('common.shape'), t('common.params')]}
            right={[3]}
            rows={shown.map(tensor => [
              tensor.name,
              tensor.dtype,
              tensor.shape.join(' × '),
              tensor.params.toLocaleString('en-US'),
            ])}
          />
        </section>
      </div>
    </PreviewChrome>
  )
}

const sectionTitle = {
  fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)',
  textTransform: 'uppercase' as const, letterSpacing: 0.4, marginBottom: 4,
} as const

/** What the client entry registers for this format. */
export const safeTensorsPreview: PreviewModule = {
  id: 'dsh-any-preview/safetensors',
  extensions: ['safetensors'],
  binary: ['safetensors'],
  load: 'renderer',
  wrap: false,
  title: () => 'SafeTensors',
  Body: SafeTensorsBody,
}
