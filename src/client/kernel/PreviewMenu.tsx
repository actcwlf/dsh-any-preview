/**
 * Shared popover used by preview toolbars.
 *
 * The trigger stays a normal toolbar button; the panel owns the common menu
 * surface, outside-click dismissal, Escape handling and focus return. Callers
 * provide only their trigger content and panel items.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/** Props the caller spreads onto its trigger button. */
export interface PreviewMenuTriggerProps {
  readonly ref: (node: HTMLButtonElement | null) => void
  readonly onClick: () => void
  readonly 'aria-expanded': boolean
  readonly 'aria-haspopup': 'menu'
  readonly 'aria-label': string
  /** Current state, for a rotating chevron. */
  readonly open: boolean
}

/** Props for the shared popover. */
export interface PreviewMenuProps {
  readonly label: string
  readonly trigger: (props: PreviewMenuTriggerProps) => ReactNode
  readonly children: ReactNode
  readonly align?: 'start' | 'end'
  /** Extra panel sizing/appearance; shared surface tokens stay in the base. */
  readonly panelStyle?: CSSProperties
}

export function PreviewMenu({ label, trigger, children, align = 'end', panelStyle }: PreviewMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

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
      {trigger({
        ref: node => { triggerRef.current = node },
        onClick: () => setOpen(value => !value),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-label': label,
        open,
      })}
      {open && (
        <div
          ref={panelRef}
          style={{
            ...panelStyleBase,
            ...(align === 'start' ? { left: 0 } : { right: 0 }),
            ...panelStyle,
          }}
          role="group"
          aria-label={label}
        >
          {children}
        </div>
      )}
    </span>
  )
}

const wrapStyle = {
  position: 'relative', display: 'inline-flex', flex: '0 0 auto',
} as const

const panelStyleBase = {
  position: 'absolute' as const, top: 'calc(100% + 4px)', zIndex: 50,
  display: 'flex', flexDirection: 'column' as const, gap: 2,
  minWidth: 40, maxWidth: '80vw', maxHeight: 260,
  padding: 4, overflowY: 'auto' as const,
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base))',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
} as const
