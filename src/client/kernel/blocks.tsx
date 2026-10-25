/**
 * Shared block rendering for lightweight markup: a tiny inline tokenizer plus a
 * block list that several formats produce (reST, notebook markdown, EPUB text).
 */
import type { ReactNode } from 'react'

/** One renderable block. */
export type Block =
  | { readonly kind: 'heading', readonly level: number, readonly text: string }
  | { readonly kind: 'paragraph', readonly text: string }
  | { readonly kind: 'code', readonly text: string, readonly language?: string }
  | { readonly kind: 'list', readonly ordered: boolean, readonly items: readonly string[] }
  | { readonly kind: 'quote', readonly text: string }

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\n]+\))/u

/**
 * Render the inline subset shared by every markup reader.
 * @param text - source line.
 * @param prefix - React key prefix.
 * @returns spans for bold, italic, code and links.
 */
export function renderInline(text: string, prefix: string): ReactNode[] {
  return text.split(INLINE).filter(part => part !== '').map((part, index) => {
    const key = `${prefix}-${String(index)}`
    if (/^\*\*[^*\n]+\*\*$/u.test(part) || /^__[^_\n]+__$/u.test(part)) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (/^`[^`\n]+`$/u.test(part)) return <code key={key} style={inlineCodeStyle}>{part.slice(1, -1)}</code>
    if (/^\*[^*\n]+\*$/u.test(part) || /^_[^_\n]+_$/u.test(part)) return <em key={key}>{part.slice(1, -1)}</em>
    const link = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/u.exec(part)
    if (link !== null) {
      return <a key={key} href={link[2]} target="_blank" rel="noreferrer" style={linkStyle}>{link[1]}</a>
    }
    return <span key={key}>{part}</span>
  })
}

/** Render a block list. */
export function Blocks({ blocks }: { readonly blocks: readonly Block[] }): ReactNode {
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `block-${String(index)}`
  switch (block.kind) {
    case 'heading': {
      const size = [22, 19, 17, 15, 14, 13][Math.min(block.level, 6) - 1] ?? 13
      return (
        <div key={key} style={{
          fontSize: size, fontWeight: 600, margin: '14px 0 6px',
          color: 'var(--dsw-alias-label-primary)', lineHeight: 1.35,
        }}>
          {renderInline(block.text, key)}
        </div>
      )
    }
    case 'code':
      return (
        <pre key={key} style={codeStyle} data-language={block.language ?? ''}>
          {block.text}
        </pre>
      )
    case 'list':
      return block.ordered
        ? (
            <ol key={key} style={listStyle}>
              {block.items.map((item, itemIndex) => <li key={`${key}-${String(itemIndex)}`}>{renderInline(item, `${key}-${String(itemIndex)}`)}</li>)}
            </ol>
          )
        : (
            <ul key={key} style={listStyle}>
              {block.items.map((item, itemIndex) => <li key={`${key}-${String(itemIndex)}`}>{renderInline(item, `${key}-${String(itemIndex)}`)}</li>)}
            </ul>
          )
    case 'quote':
      return (
        <blockquote key={key} style={quoteStyle}>
          {renderInline(block.text, key)}
        </blockquote>
      )
    default:
      return (
        <p key={key} style={paragraphStyle}>
          {renderInline(block.text, key)}
        </p>
      )
  }
}

/**
 * Parse the markdown subset that notebook cells and converted XHTML produce.
 * @param text - markdown-ish source.
 * @returns blocks; unsupported constructs degrade to paragraphs.
 */
export function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  let paragraph: string[] = []

  const flush = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()

    if (trimmed === '') {
      flush()
      index += 1
      continue
    }

    const fence = /^```\s*([\w+-]*)\s*$/u.exec(trimmed)
    if (fence !== null) {
      flush()
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!.trim())) {
        body.push(lines[index]!)
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', text: body.join('\n'), language: fence[1] ?? '' })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(trimmed)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      index += 1
      continue
    }

    if (/^([-*+])\s+/u.test(trimmed)) {
      flush()
      const items: string[] = []
      while (index < lines.length && /^\s*([-*+])\s+/u.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^\s*[-*+]\s+/u, '').trim())
        index += 1
      }
      blocks.push({ kind: 'list', ordered: false, items })
      continue
    }

    if (/^\d+[.)]\s+/u.test(trimmed)) {
      flush()
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^\s*\d+[.)]\s+/u, '').trim())
        index += 1
      }
      blocks.push({ kind: 'list', ordered: true, items })
      continue
    }

    if (trimmed.startsWith('>')) {
      flush()
      const quoted: string[] = []
      while (index < lines.length && lines[index]!.trim().startsWith('>')) {
        quoted.push(lines[index]!.trim().replace(/^>\s?/u, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', text: quoted.join(' ').trim() })
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
      flush()
      index += 1
      continue
    }

    paragraph.push(trimmed)
    index += 1
  }
  flush()
  return blocks
}

const paragraphStyle = { margin: '6px 0', lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)' } as const
const codeStyle = {
  margin: '8px 0', padding: '8px 10px', borderRadius: 6, overflowX: 'auto' as const,
  fontFamily: 'var(--dsw-font-markdown-code-block, monospace)', fontSize: 12, lineHeight: 1.55,
  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
} as const
const listStyle = { margin: '6px 0', paddingLeft: 22, lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)' } as const
const quoteStyle = {
  margin: '8px 0', padding: '2px 0 2px 10px', lineHeight: 1.7,
  borderLeft: '3px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)',
} as const
const inlineCodeStyle = {
  padding: '0 3px', borderRadius: 3, fontSize: '0.92em',
  background: 'var(--dsw-alias-bg-layer-2)',
} as const
const linkStyle = { color: 'var(--dsw-alias-brand-primary)' } as const
