'use client'

import { useState, useRef, useEffect, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { POPOVER_ENTER_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'

interface HelpPopoverProps {
  /** Popover body: the page's help text (i18n `help_*` keys per namespace). */
  children: React.ReactNode
  className?: string
}

/**
 * Page help behind a small "?" (UI-migration convention 7): a 17px circular
 * button right after the H1 opening a popover anchored at the button. No
 * instructional copy in the page flow.
 */
export function HelpPopover({ children, className }: HelpPopoverProps) {
  const tNav = useTranslations('nav')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const panelId = useId()

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !panelRef.current) return
    const t = triggerRef.current.getBoundingClientRect()
    const p = panelRef.current.getBoundingClientRect()
    const margin = 8
    const left = Math.max(margin, Math.min(t.left, window.innerWidth - p.width - margin))
    const top = Math.min(t.bottom + 6, window.innerHeight - p.height - margin)
    setPos({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    // Move focus into the panel so keyboard and screen-reader users land on
    // the help text instead of staying on the trigger.
    const raf = requestAnimationFrame(() => {
      updatePosition()
      panelRef.current?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.isConnected) return
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!panelRef.current || !panelRef.current.contains(target))
      ) {
        setOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={tNav('help')}
        className={cn(
          // The ::after pseudo-element widens the hit area to 45px for touch
          // without changing the 17px visual.
          'relative after:absolute after:-inset-[14px]',
          'inline-flex h-[17px] w-[17px] items-center justify-center rounded-full border border-border',
          'text-[11px] leading-none text-muted-foreground transition-colors duration-150',
          'hover:border-foreground/30 hover:text-foreground',
          className,
        )}
      >
        ?
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="note"
            tabIndex={-1}
            data-help-popover=""
            // Inside a modal dialog the panel is DOM-outside DialogContent:
            // data-dialog-companion keeps a click in it from dismissing the
            // dialog, and pointer-events-auto undoes the modal body lock.
            data-dialog-companion=""
            // data-ph-unmask: page help is static i18n chrome in session replays.
            data-ph-unmask=""
            className={cn('pointer-events-auto fixed z-[60] w-[300px] p-4 outline-none text-[13px] leading-relaxed', POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS)}
            style={{ top: pos.top, left: pos.left }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}
