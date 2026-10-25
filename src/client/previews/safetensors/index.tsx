/** SafeTensors header inspector: what tensors a shard holds, and their dtypes. */
import { useEffect, useState } from 'react'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { DataTable, KeyValueTable, Note, Summary } from '../../kernel/inspect.tsx'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { readRange } from '../../kernel/zip.ts'
import { MAX_HEADER_BYTES, parseHeaderJson, readHeaderLength } from './parse.ts'
import type { SafeTensorsHeader } from './parse.ts'

/** Tensors listed before the table becomes noise. */
const SHOWN_TENSORS = 500

export function SafeTensorsBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error', header?: SafeTensorsHeader, detail?: string }>({ status: 'loading' })

  useEffect(() => {
    if (absolutePath === undefined) return
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const url = fileUrl(absolutePath)
        if (url === undefined) throw new Error('无法生成文件地址')
        const length = readHeaderLength(await readRange(url, 0, 7))
        if (length === undefined) throw new Error('文件过短，不是 SafeTensors')
        if (length === 0 || length > MAX_HEADER_BYTES) {
          throw new Error(`头部长度 ${formatBytes(length)} 不合理（上限 ${formatBytes(MAX_HEADER_BYTES)}）`)
        }
        const raw = await readRange(url, 8, 8 + length - 1)
        const header = parseHeaderJson(new TextDecoder('utf-8', { fatal: false }).decode(raw), length)
        if (!alive) return
        setState({ status: 'ready', header })
      } catch (error) {
        if (alive) setState({ status: 'error', detail: error instanceof Error ? error.message : '无法解析头部' })
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (state.status !== 'ready' || state.header === undefined) {
    return <div style={PANE_FILL}>{state.status === 'loading' ? '正在读取头部…' : `无法预览：${state.detail ?? ''}`}</div>
  }

  const header = state.header
  const shown = header.tensors.slice(0, SHOWN_TENSORS)

  return (
    <div style={PANE_ROOT}>
      <Summary fields={[
        { label: '张量', value: header.tensors.length.toLocaleString('en-US') },
        { label: '参数量', value: header.totalParams.toLocaleString('en-US') },
        { label: '头部', value: formatBytes(header.headerBytes) },
        ...header.dtypes.map(([dtype, count]) => ({ label: dtype, value: `${String(count)} 个` })),
      ]} />
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '0 12px 16px' }}>
        {header.metadata.length > 0 && (
          <section style={{ marginTop: 10 }}>
            <div style={sectionTitle}>元数据</div>
            <KeyValueTable entries={header.metadata} />
          </section>
        )}
        <section style={{ marginTop: 10 }}>
          <div style={sectionTitle}>张量</div>
          <DataTable
            columns={['名称', 'dtype', '形状', '参数量']}
            right={[3]}
            rows={shown.map(tensor => [
              tensor.name,
              tensor.dtype,
              tensor.shape.join(' × '),
              tensor.params.toLocaleString('en-US'),
            ])}
          />
          {header.tensors.length > shown.length && (
            <Note>共 {header.tensors.length.toLocaleString('en-US')} 个张量，显示前 {shown.length} 个。</Note>
          )}
        </section>
      </div>
    </div>
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
