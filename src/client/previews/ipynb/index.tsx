/** Jupyter notebook viewer: markdown cells rendered, code cells and outputs shown. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { TEXT } from '../../kernel/ui.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { Blocks, parseMarkdownBlocks } from '../../kernel/blocks.tsx'
import { sanitizeHtml } from '../../kernel/html.ts'
import { previewSourceOf } from '../../kernel/source.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { parseNotebook } from './parse.ts'

/** Notebooks are read whole; this bounds what the pane will render. */
const MAX_CHARS = LIMITS.notebookChars

export function IpynbBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
  const source = previewSourceOf(content)
  const raw = source.kind === 'text' ? source.text.slice(0, MAX_CHARS) : ''
  if (raw.trim() === '') {
    return <PreviewState kind="NOTEBOOK" title={t('ipynb.title')} message={t('common.loading')} />
  }
  const notebook = parseNotebook(raw)
  if (notebook.cells.length === 0) {
    return <PreviewState kind="NOTEBOOK" title={t('ipynb.title')} message={t('ipynb.notNotebook')} tone="critical" />
  }

  return (
    <PreviewChrome
      kind="NOTEBOOK"
      title={t('ipynb.cells', { count: notebook.cells.length })}
    >
      <style>{NB_CSS}</style>
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '8px 14px 24px', fontSize: 13 }} ref={scrollportRef}>
        {notebook.cells.map((cell, index) => (
          <section key={index} style={{ marginBottom: 14 }}>
            <div style={cellLabel}>
              {cell.kind === 'code'
                ? `In [${cell.executionCount ?? ' '}]`
                : cell.kind === 'raw' ? 'raw' : 'markdown'}
            </div>
            {cell.kind === 'markdown'
              ? <Blocks blocks={parseMarkdownBlocks(cell.source)} />
              : <pre style={codeStyle}>{cell.source}</pre>}
            {cell.outputs.map((output, outputIndex) => {
              if (output.kind === 'image' && output.dataUri !== undefined) {
                return <img key={outputIndex} src={output.dataUri} alt={t('ipynb.outputImage')} style={imageStyle} />
              }
              if (output.kind === 'error') {
                return <pre key={outputIndex} style={errorStyle}>{output.text}</pre>
              }
              if (output.kind === 'html' && output.text !== undefined) {
                return (
                  <div key={outputIndex} className="dsh-nb-html" style={htmlStyle}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(output.text) }} />
                )
              }
              if (output.text !== undefined && output.text.trim() !== '') {
                return <pre key={outputIndex} style={outputStyle}>{output.text}</pre>
              }
              return null
            })}
          </section>
        ))}
      </div>
    </PreviewChrome>
  )
}

const cellLabel = {
  fontSize: TEXT.caption.fontSize, lineHeight: TEXT.caption.lineHeight,
  color: 'var(--dsw-alias-label-tertiary)', marginBottom: 2,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const

const codeStyle = {
  margin: 0, padding: '10px 12px', borderRadius: 'var(--dsw-radius-sm)', overflowX: 'auto' as const,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
} as const

const outputStyle = {
  ...codeStyle,
  marginTop: 6,
  background: 'transparent',
  borderLeft: '2px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-secondary)',
} as const

const errorStyle = {
  ...outputStyle,
  borderLeft: '2px solid var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-state-error-primary)',
} as const

const imageStyle = {
  display: 'block', maxWidth: '100%', marginTop: 6, borderRadius: 4,
} as const

const htmlStyle = {
  marginTop: 6, overflowX: 'auto' as const, fontSize: 12,
  color: 'var(--dsw-alias-label-primary)',
} as const

/** Scoped so an output's own markup cannot restyle the app. */
const NB_CSS = [
  '.dsh-nb-html table{border-collapse:collapse;font-size:12px}',
  '.dsh-nb-html th,.dsh-nb-html td{border:0.5px solid var(--dsw-alias-border-l2);padding:3px 8px;text-align:left}',
  '.dsh-nb-html thead th{background:var(--dsw-alias-bg-layer-2)}',
  '.dsh-nb-html img{max-width:100%}',
].join('')

/** What the client entry registers for this format. */
export const ipynbPreview: PreviewModule = {
  id: 'dsh-any-preview/ipynb',
  extensions: ['ipynb'],
  load: 'text-pages',
  wrap: false,
  title: () => 'Notebook',
  Body: IpynbBody,
}
