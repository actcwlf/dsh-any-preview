/**
 * SQLite schema viewer: the file header, then every `sqlite_master` row.
 * Table contents are intentionally out of scope.
 */
import { useEffect, useState } from 'react'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { Note, Summary } from '../../kernel/inspect.tsx'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import { readRange } from '../../kernel/zip.ts'
import { collectSchema, isSqlite, parseSqliteHeader } from './parse.ts'
import type { SqliteHeader, SqliteObject } from './parse.ts'

interface Loaded {
  readonly header: SqliteHeader
  readonly objects: readonly SqliteObject[]
  readonly pages: number
  readonly truncated: boolean
}

/**
 * Walk the b-tree pages that hold the schema.
 * @param url - file URL.
 */
async function readSchema(url: string): Promise<Loaded> {
  const head = await readRange(url, 0, 99)
  if (!isSqlite(head)) throw new Error('不是 SQLite 文件（缺少文件头魔数）')
  const header = parseSqliteHeader(head)
  if (header === undefined) throw new Error('文件头里的页大小无效')

  const result = await collectSchema({
    header,
    readPage: async (pageNumber) => {
      const start = (pageNumber - 1) * header.pageSize
      return await readRange(url, start, start + header.pageSize - 1)
    },
  })
  return { header, objects: result.objects, pages: result.pages, truncated: result.truncated }
}

const TYPE_LABEL: Readonly<Record<string, string>> = {
  table: '表', index: '索引', view: '视图', trigger: '触发器',
}

export function SqliteBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error', data?: Loaded, detail?: string }>({ status: 'loading' })

  useEffect(() => {
    if (absolutePath === undefined) return
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const url = fileUrl(absolutePath)
        if (url === undefined) throw new Error('无法生成文件地址')
        const data = await readSchema(url)
        if (!alive) return
        setState({ status: 'ready', data })
      } catch (error) {
        if (alive) setState({ status: 'error', detail: error instanceof Error ? error.message : '无法读取结构' })
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (state.status !== 'ready' || state.data === undefined) {
    return <div style={PANE_FILL}>{state.status === 'loading' ? '正在读取结构…' : `无法预览：${state.detail ?? ''}`}</div>
  }

  const { header, objects, pages, truncated } = state.data
  const counts = new Map<string, number>()
  for (const object of objects) counts.set(object.type, (counts.get(object.type) ?? 0) + 1)

  return (
    <div style={PANE_ROOT}>
      <Summary fields={[
        { label: '页大小', value: formatBytes(header.pageSize) },
        { label: '页数', value: header.pageCount.toLocaleString('en-US') },
        { label: '编码', value: header.encoding },
        ...[...counts.entries()].map(([type, count]) => ({ label: TYPE_LABEL[type] ?? type, value: String(count) })),
      ]} />
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 12px 20px' }}>
        {objects.length === 0 && <Note>没有可显示的 schema 对象（可能是空库）。</Note>}
        {objects.map(object => (
          <section key={`${object.type}:${object.name}`} style={{ marginBottom: 12 }}>
            <div style={objectTitle}>
              <span style={typeBadge}>{TYPE_LABEL[object.type] ?? object.type}</span>
              <span>{object.name}</span>
              {object.table !== '' && object.table !== object.name && (
                <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>· {object.table}</span>
              )}
            </div>
            {object.sql === ''
              ? <Note>（由 SQLite 自动创建，没有 SQL 定义）</Note>
              : <pre style={sqlStyle}>{object.sql}</pre>}
          </section>
        ))}
        {truncated && (
          <Note>已读取 {pages} 页、列出 {objects.length} 个对象后停止；这个库的结构异常庞大。</Note>
        )}
      </div>
    </div>
  )
}

const objectTitle = {
  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
  fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
} as const

const typeBadge = {
  fontSize: 10, padding: '0 5px', borderRadius: 4,
  color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
} as const

const sqlStyle = {
  margin: 0, padding: '6px 10px', borderRadius: 6, overflowX: 'auto' as const,
  fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', fontSize: 12, lineHeight: 1.5,
  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
} as const

/** What the client entry registers for this format. */
export const sqlitePreview: PreviewModule = {
  id: 'dsh-any-preview/sqlite',
  extensions: ['sqlite', 'sqlite3', 'db', 'db3'],
  binary: ['sqlite', 'sqlite3', 'db', 'db3'],
  load: 'renderer',
  wrap: false,
  title: () => 'SQLite',
  Body: SqliteBody,
}
