/** Streaming log viewer: severity colouring, substring filter, tail follow. */
import { useEffect, useRef, useState } from 'react'
import { useStreamedText } from '../../kernel/stream.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { createLogConsumer, levelOf } from './parse.ts'
import type { LogLevel } from './parse.ts'

const LEVEL_COLOR: Record<LogLevel, string> = {
  error: 'rgb(248, 81, 73)',
  warn: 'rgb(210, 153, 34)',
  info: 'rgb(56, 139, 253)',
  debug: 'var(--dsw-alias-label-tertiary)',
  none: 'var(--dsw-alias-label-primary)',
}

export function LogBody({ content, scrollportRef }: PreviewBodyProps) {
  const log = useStreamedText(content, () => createLogConsumer())
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const scroller = useRef<HTMLDivElement | null>(null)
  const lineCount = log?.lines.length ?? 0
  const complete = log?.complete ?? false

  useEffect(() => {
    if (!follow || !complete) return
    const element = scroller.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [follow, complete, lineCount])

  if (log === null) {
    return <div style={emptyStyle}>正在读取…</div>
  }

  const needle = query.trim().toLowerCase()
  const visible = needle === '' ? log.lines : log.lines.filter(line => line.toLowerCase().includes(needle))
  const setScroller = (element: HTMLDivElement | null): void => {
    scroller.current = element
    scrollportRef?.(element)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--dsw-alias-bg-base)' }}>
      <div style={barStyle}>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="过滤…"
          aria-label="过滤日志"
          style={inputStyle}
        />
        <label style={labelStyle}>
          <input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />
          跟随尾部
        </label>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)', marginLeft: 'auto' }}>
          {needle === ''
            ? `${log.lines.length.toLocaleString('en-US')} 行`
            : `${visible.length.toLocaleString('en-US')} / ${log.lines.length.toLocaleString('en-US')} 行`}
          {log.truncated ? ' · 已截断' : ''}
        </span>
      </div>
      <div ref={setScroller} style={{ flex: '1 1 auto', overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', fontSize: 12, lineHeight: 1.55 }}>
          {visible.map((line, index) => (
            <div key={index} style={{ display: 'flex', gap: 10, padding: '0 12px', whiteSpace: 'pre' }}>
              <span style={gutterStyle}>{index + 1}</span>
              <span style={{ color: LEVEL_COLOR[levelOf(line)] }}>{line === '' ? ' ' : line}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const inputStyle = {
  font: 'inherit', fontSize: 12, padding: '2px 8px', width: 180, borderRadius: 6,
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l2)',
} as const

const labelStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
} as const

const gutterStyle = {
  flex: '0 0 auto', width: 48, textAlign: 'right' as const,
  color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' as const,
}

const emptyStyle = {
  height: '100%', display: 'grid', placeItems: 'center', fontSize: 12,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

/** What the client entry registers for this format. */
export const logPreview: PreviewModule = {
  id: 'dsh-any-preview/log',
  extensions: ['log'],
  load: 'text-pages',
  wrap: false,
  title: () => '日志',
  Body: LogBody,
}
