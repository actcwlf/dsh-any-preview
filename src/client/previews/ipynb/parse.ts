/**
 * Jupyter notebook reader: cells, execution counts and the output kinds a reader
 * can actually show (text, images as data URIs, errors).
 */

/** One rendered output. */
export interface NotebookOutput {
  readonly kind: 'text' | 'image' | 'error' | 'html' | 'other'
  readonly text?: string
  readonly dataUri?: string
}

/** One cell. */
export interface NotebookCell {
  readonly kind: 'markdown' | 'code' | 'raw'
  readonly source: string
  readonly executionCount?: number
  readonly outputs: readonly NotebookOutput[]
}

/** A parsed notebook. */
export interface Notebook {
  readonly cells: readonly NotebookCell[]
  readonly language?: string
}

/** Refuse absurd notebooks rather than freezing the pane. */
const MAX_CELLS = 1_000

const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'] as const

function joinSource(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('')
  return ''
}

function decodeDataUri(mime: string, base64: unknown): string | undefined {
  if (typeof base64 !== 'string' || base64 === '') return undefined
  if (mime === 'image/svg+xml') return `data:${mime};charset=utf-8,${encodeURIComponent(base64)}`
  return `data:${mime};base64,${base64.replace(/\s+/gu, '')}`
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('')
  return ''
}

function readOutputs(raw: unknown): NotebookOutput[] {
  if (!Array.isArray(raw)) return []
  const outputs: NotebookOutput[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const type = record.output_type
    if (type === 'stream') {
      outputs.push({ kind: 'text', text: textOf(record.text) })
      continue
    }
    if (type === 'error') {
      const trace = Array.isArray(record.traceback) ? record.traceback.filter((line): line is string => typeof line === 'string') : []
      const head = [record.ename, record.evalue].filter(part => typeof part === 'string').join(': ')
      outputs.push({ kind: 'error', text: trace.length > 0 ? trace.join('\n') : head })
      continue
    }
    if (type === 'execute_result' || type === 'display_data') {
      const data = (record.data ?? {}) as Record<string, unknown>
      const image = IMAGE_MIME.find(mime => typeof data[mime] === 'string')
      if (image !== undefined) {
        const uri = decodeDataUri(image, data[image])
        if (uri !== undefined) outputs.push({ kind: 'image', dataUri: uri })
        continue
      }
      if (typeof data['text/html'] === 'string' && data['text/html'].trim() !== '') {
        outputs.push({ kind: 'html', text: data['text/html'] })
        continue
      }
      if (typeof data['text/plain'] === 'string') {
        outputs.push({ kind: 'text', text: data['text/plain'] })
        continue
      }
      outputs.push({ kind: 'other', text: `[${Object.keys(data).join(', ') || '输出'}]` })
    }
  }
  return outputs
}

/**
 * Parse a notebook document.
 * @param input - parsed JSON (or the raw text).
 * @returns cells and the language name; malformed input yields no cells.
 */
export function parseNotebook(input: unknown): Notebook {
  let document: unknown = input
  if (typeof input === 'string') {
    try {
      document = JSON.parse(input)
    } catch {
      return { cells: [] }
    }
  }
  if (typeof document !== 'object' || document === null) return { cells: [] }
  const record = document as Record<string, unknown>
  const metadata = (record.metadata ?? {}) as Record<string, unknown>
  const language = (metadata.language_info ?? {}) as Record<string, unknown>
  const rawCells = Array.isArray(record.cells) ? record.cells : []

  const cells: NotebookCell[] = []
  for (const raw of rawCells.slice(0, MAX_CELLS)) {
    if (typeof raw !== 'object' || raw === null) continue
    const cell = raw as Record<string, unknown>
    const type = cell.cell_type
    const kind = type === 'code' ? 'code' : type === 'raw' ? 'raw' : 'markdown'
    const executionCount = typeof cell.execution_count === 'number' ? cell.execution_count : undefined
    cells.push({
      kind,
      source: joinSource(cell.source),
      ...(executionCount === undefined ? {} : { executionCount }),
      outputs: kind === 'code' ? readOutputs(cell.outputs) : [],
    })
  }

  return {
    cells,
    ...(typeof language.name === 'string' ? { language: language.name } : {}),
  }
}
