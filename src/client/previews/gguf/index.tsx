/** GGUF inspector: architecture, quantization and tensor shapes of a model file. */
import { LIMITS } from '../../../shared/limits.ts'
import { useEffect, useState } from 'react'
import { fileUrl } from '../../kernel/file-url.ts'
import { DataTable, KeyValueTable, Note, Summary } from '../../kernel/inspect.tsx'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
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
  throw lastError instanceof Error ? lastError : new Error('无法解析 GGUF 头部')
}

function kvOf(header: GgufHeader, key: string): string | undefined {
  return header.kv.find(entry => entry.key === key)?.value
}

export function GgufBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error', header?: GgufHeader, detail?: string }>({ status: 'loading' })

  useEffect(() => {
    if (absolutePath === undefined) return
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const url = fileUrl(absolutePath)
        if (url === undefined) throw new Error('无法生成文件地址')
        const header = await readHeader(url)
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
        { label: '版本', value: String(header.version) },
        { label: '架构', value: kvOf(header, 'general.architecture') ?? '' },
        { label: '名称', value: kvOf(header, 'general.name') ?? '' },
        { label: '张量', value: header.tensorCount.toLocaleString('en-US') },
        { label: '元数据', value: `${header.kvCount.toLocaleString('en-US')} 项` },
        ...header.quantizations.slice(0, 3).map(([type, count]) => ({ label: type, value: `${String(count)} 个` })),
      ]} />
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '0 12px 16px' }}>
        <section style={{ marginTop: 10 }}>
          <div style={sectionTitle}>元数据</div>
          <KeyValueTable entries={header.kv.map(entry => [entry.key, entry.value])} />
          {header.kvCount > header.kv.length && (
            <Note>共 {header.kvCount.toLocaleString('en-US')} 项元数据，显示前 {header.kv.length} 项。</Note>
          )}
        </section>
        <section style={{ marginTop: 14 }}>
          <div style={sectionTitle}>张量</div>
          <DataTable
            columns={['名称', '类型', '维度', '参数量']}
            right={[3]}
            rows={shown.map(tensor => [
              tensor.name,
              tensor.type,
              tensor.dims.join(' × '),
              tensor.params.toLocaleString('en-US'),
            ])}
          />
          {header.tensorCount > shown.length && (
            <Note>共 {header.tensorCount.toLocaleString('en-US')} 个张量，显示前 {shown.length} 个。</Note>
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
export const ggufPreview: PreviewModule = {
  id: 'dsh-any-preview/gguf',
  extensions: ['gguf'],
  binary: ['gguf'],
  load: 'renderer',
  wrap: false,
  title: () => 'GGUF',
  Body: GgufBody,
}
