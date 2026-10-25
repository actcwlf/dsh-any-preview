/** Unified diff / patch viewer with search. */
import { useMemo, useState } from 'react'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { filterRows } from '../../kernel/search.ts'
import { useStreamedText } from '../../kernel/stream.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { createDiffConsumer } from './parse.ts'
import type { DiffLineKind } from './parse.ts'

const BACKGROUND: Record<DiffLineKind, string | undefined> = {
  add: 'rgba(46, 160, 67, 0.16)',
  del: 'rgba(248, 81, 73, 0.16)',
  file: 'var(--dsw-alias-bg-layer-2)',
  hunk: 'var(--dsw-alias-bg-layer-2)',
  note: undefined,
  context: undefined,
}

const COLOR: Record<DiffLineKind, string> = {
  add: 'var(--dsw-alias-label-primary)',
  del: 'var(--dsw-alias-label-primary)',
  file: 'var(--dsw-alias-label-primary)',
  hunk: 'var(--dsw-alias-label-secondary)',
  note: 'var(--dsw-alias-label-tertiary)',
  context: 'var(--dsw-alias-label-secondary)',
}

export function DiffBody({ content, scrollportRef }: PreviewBodyProps) {
  const diff = useStreamedText(content, () => createDiffConsumer())
  const [query, setQuery] = useState('')
  const lines = diff?.lines ?? []
  const filtered = useMemo(
    () => filterRows(lines, query, line => line.text),
    [lines, lines.length, query],
  )

  if (diff === null) {
    return <div style={emptyStyle}>正在读取…</div>
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)' }}>
      <div style={barStyle}>
        <span>
          {diff.lines.length.toLocaleString('en-US')} 行
          {' · '}
          <span style={{ color: 'rgb(46, 160, 67)' }}>+{diff.added.toLocaleString('en-US')}</span>
          {' '}
          <span style={{ color: 'rgb(248, 81, 73)' }}>−{diff.removed.toLocaleString('en-US')}</span>
        </span>
        <SearchBar
          value={query}
          onChange={setQuery}
          matches={filtered.rows.length}
          total={diff.lines.length}
        />
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {diff.truncated ? '已截断' : '差异视图'}
        </span>
      </div>
      <div ref={scrollportRef} style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', fontSize: 12, lineHeight: 1.55 }}>
          {filtered.rows.map((line, offset) => (
            <div
              key={filtered.indices[offset]}
              style={{
                display: 'flex',
                gap: 10,
                padding: '0 12px',
                background: BACKGROUND[line.kind],
                color: COLOR[line.kind],
                fontWeight: line.kind === 'file' ? 600 : 400,
                fontStyle: line.kind === 'note' ? 'italic' : 'normal',
                whiteSpace: 'pre',
              }}
            >
              <span style={{ flex: '0 0 auto', width: 48, textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' }}>
                {(filtered.indices[offset] ?? 0) + 1}
              </span>
              <span style={{ flex: '1 1 auto' }}>{line.text === '' ? ' ' : line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const emptyStyle = {
  height: '100%', display: 'grid', placeItems: 'center', fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

/** What the client entry registers for this format. */
export const diffPreview: PreviewModule = {
  id: 'dsh-any-preview/diff',
  extensions: ['diff', 'patch'],
  load: 'text-pages',
  wrap: false,
  title: () => '差异视图',
  Body: DiffBody,
}
