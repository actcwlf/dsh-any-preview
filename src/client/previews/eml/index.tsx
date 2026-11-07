/** `.eml` viewer: headers, the message text, and attachment names. */
import { PreviewChrome } from '../../kernel/chrome.tsx'
import { PreviewState } from '../../kernel/PreviewState.tsx'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { useMemo } from 'react'
import { previewSourceOf } from '../../kernel/source.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'
import { PRIMARY_HEADERS, headerLabel, parseEml } from './parse.ts'

/** Only the head of a huge message is parsed; attachments are not extracted. */
const MAX_CHARS = 2 * 1024 * 1024

export function EmlBody({ content, scrollportRef }: PreviewBodyProps) {
  useLocale()
  const source = previewSourceOf(content)
  const raw = source.kind === 'text' ? source.text : ''
  const mail = useMemo(() => parseEml(raw.slice(0, MAX_CHARS)), [raw])
  const subject = mail.headers.find(header => header.name === 'subject')?.value.trim() ?? ''

  if (raw === '') {
    return <PreviewState kind="EML" title={t('eml.title')} message={t('common.loading')} />
  }

  const ordered = [
    ...PRIMARY_HEADERS
      .map(name => mail.headers.find(header => header.name === name))
      .filter((header): header is NonNullable<typeof header> => header !== undefined),
    ...mail.headers.filter(header => !PRIMARY_HEADERS.includes(header.name as typeof PRIMARY_HEADERS[number])
      && header.name !== 'content-type' && header.name !== 'content-transfer-encoding'),
  ]

  return (
    <PreviewChrome kind="EML" title={subject === '' ? t('eml.title') : subject}>
      <div style={{ flex: '1 1 auto', overflow: 'auto', padding: '10px 14px' }} ref={scrollportRef}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, marginBottom: 14 }}>
          <tbody>
            {ordered.map((header, index) => (
              <tr key={`${header.name}-${String(index)}`}>
                <td style={labelCell}>{headerLabel(header.name)}</td>
                <td style={valueCell}>{header.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {mail.attachments.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 }}>
            {t('eml.attachments', { names: mail.attachments.join('、') })}
          </div>
        )}
        <pre style={{
          margin: 0,
          fontFamily: 'var(--dsw-font-family)',
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--dsw-alias-label-primary)',
        }}>
          {mail.text === '' ? t('eml.noBody') : mail.text}
        </pre>
      </div>
    </PreviewChrome>
  )
}

const labelCell = {
  padding: '2px 12px 2px 0',
  verticalAlign: 'top' as const,
  whiteSpace: 'nowrap' as const,
  color: 'var(--dsw-alias-label-tertiary)',
} as const

const valueCell = {
  padding: '2px 0',
  wordBreak: 'break-word' as const,
  color: 'var(--dsw-alias-label-primary)',
} as const

/** What the client entry registers for this format. */
export const emlPreview: PreviewModule = {
  id: 'dsh-any-preview/eml',
  extensions: ['eml'],
  load: 'text-pages',
  wrap: false,
  title: () => t('eml.title'),
  Body: EmlBody,
}
