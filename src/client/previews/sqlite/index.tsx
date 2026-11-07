/**
 * SQLite schema viewer: the file header, then every `sqlite_master` row.
 * Table contents are intentionally out of scope.
 */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { TEXT } from '../../kernel/ui.ts'
import { useEffect, useState } from 'react'
import { t } from '../../i18n.ts'
import { useLocale } from '../../useLocale.ts'
import { PreviewError } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { Note, Summary } from '../../kernel/inspect.tsx'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import type { MessageKey } from '../../locales.ts'
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

/** Display label per schema object type. */
const TYPE_KEY: Readonly<Record<string, MessageKey>> = {
  table: 'common.table',
  index: 'common.index',
  view: 'common.view',
  trigger: 'common.trigger',
}

function typeLabel(type: string): string {
  const key = TYPE_KEY[type]
  return key === undefined ? type : t(key)
}

/**
 * Walk the b-tree pages that hold the schema.
 * @param url - file URL.
 */
async function readSchema(url: string): Promise<Loaded> {
  const head = await readRange(url, 0, 99)
  if (!isSqlite(head)) throw new PreviewError('sqlite.notSqlite')
  const header = parseSqliteHeader(head)
  if (header === undefined) throw new PreviewError('sqlite.badPageSize')

  const result = await collectSchema({
    header,
    readPage: async (pageNumber) => {
      const start = (pageNumber - 1) * header.pageSize
      return await readRange(url, start, start + header.pageSize - 1)
    },
  })
  return { header, objects: result.objects, pages: result.pages, truncated: result.truncated }
}

export function SqliteBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const { absolutePath } = useDocument(content, resourceAddress, useResource)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error', data?: Loaded, detail?: string }>({ status: 'loading' })

  useEffect(() => {
    if (absolutePath === undefined) return
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      try {
        const url = fileUrl(absolutePath)
        if (url === undefined) throw new PreviewError('common.fileUrl')
        const data = await readSchema(url)
        if (!alive) return
        setState({ status: 'ready', data })
      } catch (error) {
        if (!alive) return
        const detail = error instanceof PreviewError
          ? t(error.key, error.params)
          : t('sqlite.readFailed')
        setState({ status: 'error', detail })
      }
    })()
    return () => { alive = false }
  }, [absolutePath])

  if (state.status !== 'ready' || state.data === undefined) {
    const failed = state.status === 'error'
    return (
      <PreviewState
        kind="SQLITE"
        title={failed ? t('common.failed') : t('sqlite.loading')}
        message={failed ? t('common.error', { detail: state.detail ?? '' }) : t('sqlite.loading')}
        tone={failed ? 'critical' : 'normal'}
      />
    )
  }

  const { header, objects, pages, truncated } = state.data
  const counts = new Map<string, number>()
  for (const object of objects) counts.set(object.type, (counts.get(object.type) ?? 0) + 1)

  return (
    <PreviewChrome
      kind="SQLITE"
      title={t('count.items', { count: objects.length.toLocaleString('en-US') })}
    >
      <Summary fields={[
        { label: t('common.pageSize'), value: formatBytes(header.pageSize) },
        { label: t('common.pages'), value: header.pageCount.toLocaleString('en-US') },
        { label: t('common.encoding'), value: header.encoding },
        ...[...counts.entries()].map(([type, count]) => ({ label: typeLabel(type), value: String(count) })),
      ]} />
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 12px 20px' }}>
        {objects.length === 0 && <Note>{t('sqlite.noObjects')}</Note>}
        {objects.map(object => (
          <section key={`${object.type}:${object.name}`} style={{ marginBottom: 12 }}>
            <div style={objectTitle}>
              <span style={typeBadge}>{typeLabel(object.type)}</span>
              <span>{object.name}</span>
              {object.table !== '' && object.table !== object.name && (
                <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>· {object.table}</span>
              )}
            </div>
            {object.sql === ''
              ? <Note>{t('sqlite.autoCreated')}</Note>
              : <pre style={sqlStyle}>{object.sql}</pre>}
          </section>
        ))}
        {truncated && (
          <Note>{t('sqlite.truncated', { pages, objects: objects.length })}</Note>
        )}
      </div>
    </PreviewChrome>
  )
}

const objectTitle = {
  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
  fontSize: TEXT.meta.fontSize, lineHeight: TEXT.meta.lineHeight,
  fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
} as const

const typeBadge = {
  fontSize: TEXT.caption.fontSize, lineHeight: TEXT.caption.lineHeight,
  padding: '0 5px', borderRadius: 4,
  color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
} as const

const sqlStyle = {
  margin: 0, padding: '6px 10px', borderRadius: 6, overflowX: 'auto' as const,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 12, lineHeight: 1.5,
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
