/**
 * A compact `⋯` control for toolbars that cannot fit every action.
 *
 * The bar keeps its 32px height; only the controls move into this panel. That is
 * preferable to wrapping the bar or hiding tools behind `overflow: hidden`.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { t } from '../i18n.ts'
import { CHROME_CONTROL } from './ui.ts'

/** Props for the overflow button/panel. */
export interface ToolbarOverflowProps {
  readonly label?: string
  readonly children: ReactNode
}

export function ToolbarOverflow({ label, children }: ToolbarOverflowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const title = label ?? t('common.more')

  useEffect(() => {
    if (!open) return
    const doc = triggerRef.current?.ownerDocument
    if (doc === undefined || doc === null) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (triggerRef.current?.contains(target) === true) return
      if (panelRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    doc.addEventListener('pointerdown', onPointer, true)
    doc.addEventListener('keydown', onKey)
    return () => {
      doc.removeEventListener('pointerdown', onPointer, true)
      doc.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span style={wrapStyle}>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-preview-control"
        style={triggerStyle}
        onClick={() => setOpen((value) => !value)}
        aria-label={title}
        title={title}
        aria-expanded={open}
        data-preview-overflow="true"
      >
        ⋯
      </button>
      {open && (
        <div ref={panelRef} style={panelStyle} role="group" aria-label={title}>
          {children}
        </div>
      )}
    </span>
  )
}

const wrapStyle = {
  position: 'relative', display: 'inline-flex', flex: '0 0 auto',
} as const

const triggerStyle = {
  ...CHROME_CONTROL,
  width: 28,
  padding: 0,
  fontSize: 16,
  lineHeight: '28px',
  textAlign: 'center' as const,
  flex: '0 0 auto',
} as const

const panelStyle = {
  position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 50,
  minWidth: 40, maxWidth: '80vw', maxHeight: 260,
  display: 'flex', flexDirection: 'column', gap: 2,
  padding: 4, overflowY: 'auto',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  background: 'var(--dsw-alias-bg-base)',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, .18)',
} as const
