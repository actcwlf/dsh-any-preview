/** reStructuredText viewer. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { PANE_FILL } from '../../kernel/layout.ts'
import { Blocks } from '../../kernel/blocks.tsx'
import { previewSourceOf } from '../../kernel/source.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { parseRst } from './parse.ts'

/** Expanded text is capped so a huge dump cannot stall the pane. */
const MAX_CHARS = LIMITS.rstChars

export function RstBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
  const source = previewSourceOf(content)
  const text = source.kind === 'text' ? source.text.slice(0, MAX_CHARS) : ''
  if (text.trim() === '') return <div style={PANE_FILL}>{t('common.loading')}</div>
  return (
    <PreviewChrome>
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 16px 24px', fontSize: 13 }} ref={scrollportRef}>
        <Blocks blocks={parseRst(text)} />
      </div>
    </PreviewChrome>
  )
}

/** What the client entry registers for this format. */
export const rstPreview: PreviewModule = {
  id: 'dsh-any-preview/rst',
  extensions: ['rst'],
  load: 'text-pages',
  wrap: false,
  title: () => 'reStructuredText',
  Body: RstBody,
}
