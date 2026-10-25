/** Unified-diff line classification, streamed as lines arrive. */
import { createLineConsumer } from '../../kernel/lines.ts'
import type { LineConsumer } from '../../kernel/lines.ts'
import type { StreamConsumer } from '../../kernel/stream.ts'

/** How one diff line reads. */
export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'note'

/** One classified line. */
export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
}

/** A streaming diff model. */
export interface DiffConsumer extends StreamConsumer {
  readonly lines: readonly DiffLine[]
  readonly added: number
  readonly removed: number
  readonly truncated: boolean
}

const FILE_HEADERS = [
  'diff ', 'Index:', '--- ', '+++ ', 'new file mode ', 'deleted file mode ',
  'similarity index ', 'dissimilarity index ', 'rename ', 'old mode ', 'new mode ',
] as const

/**
 * Classify one line. Header prefixes are matched before the +/- body markers,
 * because `---`/`+++` would otherwise read as a removal and an addition.
 * @param line - one line without its terminator.
 * @returns the kind.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  for (const prefix of FILE_HEADERS) {
    if (line.startsWith(prefix)) return 'file'
  }
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('\\')) return 'note'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

/**
 * Build a consumer that classifies lines under a budget.
 * @param maxLines - line budget; past it the model reports truncation.
 * @returns the consumer.
 */
export function createDiffConsumer(maxLines = 20_000): DiffConsumer {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let truncated = false

  const sink: LineConsumer = createLineConsumer((line) => {
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    const kind = classifyDiffLine(line)
    if (kind === 'add') added += 1
    if (kind === 'del') removed += 1
    lines.push({ kind, text: line })
  })

  return {
    push: sink.push,
    finish: sink.finish,
    get lines(): readonly DiffLine[] {
      return lines
    },
    get added(): number {
      return added
    },
    get removed(): number {
      return removed
    },
    get truncated(): boolean {
      return truncated
    },
  }
}
