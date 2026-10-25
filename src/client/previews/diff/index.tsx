/** Unified diff / patch viewer with search. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from '../../kernel/marks.tsx'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import { SearchBar } from '../../kernel/SearchBar.tsx'
import { scrollToRow } from '../../kernel/scroll.ts'
import { DEFAULT_SEARCH } from '../../kernel/search.ts'
import type { SearchOptions } from '../../kernel/search.ts'
import { useSearch } from '../../kernel/useSearch.ts'
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
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH)
  const [filter, setFilter] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const lines = diff?.lines ?? []
  const texts = useMemo(() => lines.map(line => line.text), [lines, lines.length])
  const found = useSearch(texts, options)

  const visible = useMemo(() => {
    if (!filter || found.pattern === undefined) return lines.map((line, index) => ({ line, index }))
    return found.matches.map(index => ({ line: lines[index]!, index }))
  }, [lines, lines.length, filter, found.pattern, found.matches])

  useEffect(() => {
    if (found.activeRow === undefined) return
    scrollToRow(scroller.current, found.activeRow)
  }, [found.activeRow])

  if (diff === null) {
    return <div style={PANE_FILL}>正在读取…</div>
  }

  const setScroller = (element: HTMLDivElement | null): void => {
    scroller.current = element
    scrollportRef?.(element)
  }

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span>
          {diff.lines.length.toLocaleString('en-US')} 行
          {' · '}
          <span style={{ color: 'rgb(46, 160, 67)' }}>+{diff.added.toLocaleString('en-US')}</span>
          {' '}
          <span style={{ color: 'rgb(248, 81, 73)' }}>−{diff.removed.toLocaleString('en-US')}</span>
        </span>
        <SearchBar
          options={options}
          onChange={setOptions}
          matches={found.matches.length}
          index={found.index}
          total={diff.lines.length}
          onPrev={found.prev}
          onNext={found.next}
          filter={filter}
          onFilter={setFilter}
        />
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {diff.truncated ? '已截断' : ''}
        </span>
      </div>
      <div ref={setScroller} style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', fontSize: 12, lineHeight: 1.55 }}>
          {visible.map(({ line, index }) => (
            <div
              key={index}
              data-row-index={index}
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
                {index + 1}
              </span>
              <span style={{ flex: '1 1 auto' }}>
                <Marked text={line.text === '' ? ' ' : line.text} pattern={found.pattern} />
              </span>
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


/** What the client entry registers for this format. */
export const diffPreview: PreviewModule = {
  id: 'dsh-any-preview/diff',
  extensions: ['diff', 'patch'],
  load: 'text-pages',
  wrap: false,
  title: () => '差异视图',
  Body: DiffBody,
}
