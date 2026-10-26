/**
 * reStructuredText reader: the subset that README.rst and docs/*.rst actually
 * use — adorned headings, bullet/enumerated lists, literal blocks, simple and
 * grid tables, footnotes, substitution definitions, the common directives, and
 * inline emphasis/code/links. Anything unrecognized degrades to a paragraph.
 */
import type { Block } from './document.ts'

const ADORNMENT = /^([=\-~^"'#*+`:.])\1{2,}$/u
const DIRECTIVE = /^\.\.\s+([a-zA-Z][\w-]*)::\s*(.*)$/u
const TARGET = /^\.\.\s+_[^:]+:\s*$/u
const BULLET = /^(\s*)[-*+]\s+(.*)$/u
const ENUMERATED = /^(\s*)(\d+[.)]|[a-zA-Z][.)]|#\.)\s+(.*)$/u
const SUBSTITUTION = /^\.\.\s+\|([^|]+)\|\s+([a-zA-Z]+)::\s*(.*)$/u
const FOOTNOTE = /^\.\.\s+\[([^\]]+)\]\s+(.*)$/u
const SIMPLE_BORDER = /^=+( +=+)+$/u
const GRID_BORDER = /^\+(?:[-=]+\+)+$/u

/** Directives whose body is prose worth showing. */
const CALLOUTS = new Set(['note', 'warning', 'tip', 'important', 'danger', 'caution', 'admonition'])
/** Directives whose body is code. */
const CODE = new Set(['code-block', 'code', 'sourcecode'])
/** Directives that name an asset. */
const ASSETS = new Set(['image', 'figure'])

interface Cursor {
  readonly lines: readonly string[]
  index: number
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Collect the indented block that follows a directive or `::` line. */
function takeIndented(cursor: Cursor): string[] {
  const body: string[] = []
  let base = -1
  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index]!
    if (line.trim() === '') {
      body.push('')
      cursor.index += 1
      continue
    }
    const indent = indentOf(line)
    if (base < 0) {
      if (indent === 0) break
      base = indent
    }
    if (indent < base) break
    body.push(line.slice(base))
    cursor.index += 1
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  // The blank line separating a directive from its body is a separator, not content.
  while (body.length > 0 && body[0] === '') body.shift()
  return body
}

/** Column spans from an `=== ===` border. */
function simpleColumns(border: string): Array<readonly [number, number]> {
  return [...border.matchAll(/=+/gu)].map(match => [match.index!, match.index! + match[0].length] as const)
}

/** Parse a simple table starting at its top border. */
function parseSimpleTable(lines: readonly string[], start: number): { block: Block, next: number } | undefined {
  const top = lines[start]!
  if (!SIMPLE_BORDER.test(top.trim())) return undefined
  const columns = simpleColumns(top.trimStart())
  const offset = indentOf(top)
  const beforeSeparator: string[][] = []
  const rows: string[][] = []
  let separatorSeen = false
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]!
    if (SIMPLE_BORDER.test(line.trim())) {
      index += 1
      if (!separatorSeen) {
        separatorSeen = true
        continue
      }
      break
    }
    if (line.trim() === '') break
    const cells = columns.map(([from, to]) => line.slice(offset + from, offset + to).trim())
    ;(separatorSeen ? rows : beforeSeparator).push(cells)
    index += 1
  }
  if (!separatorSeen) return undefined
  return { block: { kind: 'table', header: beforeSeparator[0] ?? [], rows }, next: index }
}

/** Parse a grid table starting at its top border. */
function parseGridTable(lines: readonly string[], start: number): { block: Block, next: number } | undefined {
  const border = lines[start]!
  if (!GRID_BORDER.test(border.trim())) return undefined
  const stops = [...border.trim().matchAll(/\+/gu)].map(match => match.index!)
  if (stops.length < 2) return undefined
  const header: string[][] = []
  const rows: string[][] = []
  let headerDone = false
  let index = start + 1
  while (index < lines.length) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed.startsWith('|')) {
      const cells: string[] = []
      for (let column = 0; column + 1 < stops.length; column += 1) {
        cells.push(trimmed.slice(stops[column]! + 1, stops[column + 1]!).trim())
      }
      ;(headerDone ? rows : header).push(cells)
      index += 1
      continue
    }
    if (GRID_BORDER.test(trimmed)) {
      if (trimmed.includes('=')) headerDone = true
      index += 1
      continue
    }
    break
  }
  if (header.length === 0 && rows.length === 0) return undefined
  return {
    block: { kind: 'table', header: header[0] ?? [], rows: headerDone ? rows : rows },
    next: index,
  }
}

/** Apply substitutions and footnote references to one block's text. */
function mapBlock(block: Block, apply: (text: string) => string): Block {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return { ...block, text: apply(block.text) }
    case 'list':
      return { ...block, items: block.items.map(apply) }
    case 'table':
      return { ...block, header: block.header.map(apply), rows: block.rows.map(row => row.map(apply)) }
    default:
      return block
  }
}

/**
 * Parse reStructuredText into blocks.
 * @param source - the file text.
 * @returns blocks for the shared renderer.
 */
export function parseRst(source: string): Block[] {
  const normalized = source
    .replaceAll('\r\n', '\n')
    // Role prefixes carry no visual value here: `:ref:`label`` reads as `label`.
    .replace(/:([a-zA-Z][\w-]*):`([^`]+)`/gu, '`$2`')

  const substitutions = new Map<string, string>()
  const footnotes: { label: string, text: string }[] = []
  for (const line of normalized.split('\n')) {
    const substitution = SUBSTITUTION.exec(line.trim())
    if (substitution !== null) {
      const [, name, kind, value] = substitution
      substitutions.set(name!.trim(), kind === 'image' ? `[图片] ${value!.trim()}` : value!.trim())
      continue
    }
    const footnote = FOOTNOTE.exec(line.trim())
    if (footnote !== null) footnotes.push({ label: footnote[1]!, text: footnote[2]!.trim() })
  }

  const applyText = (text: string): string => {
    let output = text
    for (const [name, value] of substitutions) output = output.replaceAll(`|${name}|`, value)
    // A footnote reference renders as its label.
    return output.replace(/\[([^\]\n]+)\]_/gu, '[$1]')
  }

  const cursor: Cursor = { lines: normalized.split('\n'), index: 0 }
  let blocks: Block[] = []
  const adornments: string[] = []
  const levelOf = (char: string): number => {
    const known = adornments.indexOf(char)
    if (known >= 0) return known + 1
    adornments.push(char)
    return adornments.length
  }

  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index]!
    const trimmed = line.trim()

    if (trimmed === '') {
      cursor.index += 1
      continue
    }

    // Overlined heading: adornment, title, same adornment.
    if (ADORNMENT.test(trimmed)) {
      const next = cursor.lines[cursor.index + 1]
      const under = cursor.lines[cursor.index + 2]
      if (next !== undefined && next.trim() !== '' && under !== undefined && under.trim() === trimmed) {
        blocks.push({ kind: 'heading', level: levelOf(trimmed[0]!), text: next.trim() })
        cursor.index += 3
        continue
      }
      cursor.index += 1
      continue
    }

    // Underlined heading: title, then an adornment line.
    const under = cursor.lines[cursor.index + 1]
    if (under !== undefined && ADORNMENT.test(under.trim()) && under.trim()[0] === under.trim()[1]) {
      blocks.push({ kind: 'heading', level: levelOf(under.trim()[0]!), text: trimmed })
      cursor.index += 2
      continue
    }

    const table = parseSimpleTable(cursor.lines, cursor.index) ?? parseGridTable(cursor.lines, cursor.index)
    if (table !== undefined) {
      blocks.push(table.block)
      cursor.index = table.next
      continue
    }

    if (TARGET.test(trimmed) || SUBSTITUTION.test(trimmed) || FOOTNOTE.test(trimmed)) {
      cursor.index += 1
      continue
    }

    const directive = DIRECTIVE.exec(trimmed)
    if (directive !== null) {
      const name = directive[1]!.toLowerCase()
      const argument = directive[2]!.trim()
      cursor.index += 1
      const body = takeIndented(cursor)
      if (CODE.has(name)) {
        blocks.push({ kind: 'code', text: body.join('\n'), language: argument })
        continue
      }
      if (CALLOUTS.has(name)) {
        const label = argument === '' ? name : `${name}: ${argument}`
        blocks.push({ kind: 'quote', text: [label, ...body.filter(part => part !== '')].join('\n') })
        continue
      }
      if (ASSETS.has(name)) {
        blocks.push({ kind: 'paragraph', text: `[图片] ${argument}` })
        continue
      }
      if (name === 'toctree') {
        const entries = body
          .map(part => part.trim())
          .filter(part => part !== '' && !part.startsWith(':'))
        blocks.push({ kind: 'paragraph', text: '目录' })
        if (entries.length > 0) blocks.push({ kind: 'list', ordered: false, items: entries })
        continue
      }
      // contents / include and unknown directives: keep their body text.
      if (body.length > 0) blocks.push({ kind: 'paragraph', text: body.join(' ').trim() })
      continue
    }

    if (BULLET.test(line)) {
      const items: string[] = []
      const markerIndent = indentOf(line)
      while (cursor.index < cursor.lines.length) {
        const current = cursor.lines[cursor.index]!
        const bullet = BULLET.exec(current)
        if (bullet !== null && indentOf(current) === markerIndent) {
          items.push(bullet[2]!.trim())
          cursor.index += 1
          continue
        }
        if (items.length > 0 && current.trim() !== '' && indentOf(current) > markerIndent) {
          items[items.length - 1] = `${items[items.length - 1]!} ${current.trim()}`
          cursor.index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered: false, items })
      continue
    }

    const enumerated = ENUMERATED.exec(line)
    if (enumerated !== null) {
      const items: string[] = []
      const markerIndent = indentOf(line)
      while (cursor.index < cursor.lines.length) {
        const current = cursor.lines[cursor.index]!
        const match = ENUMERATED.exec(current)
        if (match !== null && indentOf(current) === markerIndent) {
          items.push(match[3]!.trim())
          cursor.index += 1
          continue
        }
        if (items.length > 0 && current.trim() !== '' && indentOf(current) > markerIndent) {
          items[items.length - 1] = `${items[items.length - 1]!} ${current.trim()}`
          cursor.index += 1
          continue
        }
        break
      }
      blocks.push({ kind: 'list', ordered: true, items })
      continue
    }

    // Paragraph, possibly ending in `::` which introduces a literal block.
    const paragraph: string[] = [trimmed]
    cursor.index += 1
    while (cursor.index < cursor.lines.length) {
      const current = cursor.lines[cursor.index]!
      if (current.trim() === '') break
      if (ADORNMENT.test(current.trim())) break
      if (BULLET.test(current) || ENUMERATED.test(current)) break
      if (DIRECTIVE.test(current.trim()) || TARGET.test(current.trim())) break
      paragraph.push(current.trim())
      cursor.index += 1
    }
    const joined = paragraph.join(' ')
    if (joined.endsWith('::')) {
      const head = joined.slice(0, -2).trimEnd()
      if (head !== '') blocks.push({ kind: 'paragraph', text: `${head}:` })
      while (cursor.index < cursor.lines.length && cursor.lines[cursor.index]!.trim() === '') cursor.index += 1
      const literal = takeIndented(cursor)
      if (literal.length > 0) blocks.push({ kind: 'code', text: literal.join('\n') })
      continue
    }
    blocks.push({ kind: 'paragraph', text: joined })
  }

  blocks = blocks.map(block => mapBlock(block, applyText))
  if (footnotes.length > 0) {
    blocks.push({ kind: 'list', ordered: false, items: footnotes.map(footnote => `[${footnote.label}] ${footnote.text}`) })
  }
  return blocks
}
