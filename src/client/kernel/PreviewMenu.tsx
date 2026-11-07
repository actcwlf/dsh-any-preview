/**
 * Shared popover used by preview toolbars.
 *
 * The panel is portalled to the document body so a toolbar near the bottom of a
 * pane cannot clip it. The trigger stays a normal toolbar button; the panel owns
 * the common menu surface, positioning, outside-click dismissal, Escape
 * handling and focus return.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'

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

interface Position {
  readonly top: number
  readonly left: number
}

export function PreviewMenu({ label, trigger, children, align = 'end', panelStyle }: PreviewMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<Position | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const doc = triggerRef.current?.ownerDocument
    const view = doc?.defaultView
    if (doc === undefined || doc === null || view === undefined || view === null) return

    const update = (): void => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (trigger === null || panel === null) return
      const rect = trigger.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const margin = 8
      const gap = 4
      const viewportWidth = view.innerWidth
      const viewportHeight = view.innerHeight

      let top = rect.bottom + gap
      if (top + height > viewportHeight - margin && rect.top - gap - height >= margin) {
        top = rect.top - gap - height
      }
      top = Math.max(margin, Math.min(top, viewportHeight - margin - height))
      let left = align === 'end' ? rect.right - width : rect.left
      left = Math.max(margin, Math.min(left, viewportWidth - margin - width))
      setPosition(current => (
        current !== null && current.top === top && current.left === left
          ? current
          : { top, left }
      ))
    }

    update()
    view.addEventListener('resize', update)
    view.addEventListener('scroll', update, true)
    return () => {
      view.removeEventListener('resize', update)
      view.removeEventListener('scroll', update, true)
    }
  }, [open, align, children])

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

  const container = triggerRef.current?.ownerDocument.body
  return (
    <span style={wrapStyle}>
      {trigger({
        ref: node => { triggerRef.current = node },
        onClick: () => {
          setPosition(null)
          setOpen(value => !value)
        },
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        'aria-label': label,
        open,
      })}
      {open && container !== undefined && createPortal(
        <div
          ref={panelRef}
          style={{
            ...panelStyleBase,
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position === null ? 'hidden' : 'visible',
            ...panelStyle,
          }}
          role="group"
          aria-label={label}
          data-preview-menu="true"
        >
          {children}
        </div>,
        container,
      )}
    </span>
  )
}

const wrapStyle = {
  position: 'relative', display: 'inline-flex', flex: '0 0 auto',
} as const

const panelStyleBase = {
  position: 'fixed' as const, zIndex: 1000,
  display: 'flex', flexDirection: 'column' as const, gap: 2,
  minWidth: 40, maxWidth: 'calc(100vw - 16px)', maxHeight: 260,
  padding: 4, overflowY: 'auto' as const,
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base))',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
} as const
