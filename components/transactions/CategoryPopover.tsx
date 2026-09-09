'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

/**
 * The category picker (Kick-style): the template list opens beside the
 * chip or button that was clicked instead of in a modal over the page. A
 * fixed panel placed from the anchor's rectangle, kept inside the viewport,
 * closed by Escape, a click outside, or a resize. The content is three
 * children (a head, the list, a foot); every consumer passes the same
 * TemplatePicker in its dense mode as the list.
 *
 * Built on the non-modal Radix dialog so it also works inside a modal
 * dialog (Ny verifikation, Bokför direkt): the host's focus trap pauses
 * while this layer is open, a click in here never dismisses the host, and
 * Escape closes this panel only.
 */

const WIDTH = 400
const MAX_HEIGHT = 520
const GAP = 6
const MARGIN = 10

export function CategoryPopover({
  anchor,
  onClose,
  children,
  className,
}: {
  anchor: HTMLElement | null
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const t = useTranslations('tx_template_picker')
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const height = Math.min(MAX_HEIGHT, panelRef.current?.offsetHeight ?? MAX_HEIGHT)
      const below = r.bottom + GAP
      const top = below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, r.top - GAP - height)
      const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - WIDTH - MARGIN))
      setPos({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  return (
    <DialogPrimitive.Root open={!!anchor} modal={false} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={panelRef}
          data-dialog-companion=""
          aria-describedby={undefined}
          onInteractOutside={(e) => {
            // The anchor's own click toggles the panel; treating it as an
            // outside click would close and reopen it in the same gesture.
            if (anchor && e.target instanceof Node && anchor.contains(e.target)) e.preventDefault()
          }}
          className={cn(
            // Three rows: head, the scrolling list, foot. A grid keeps the list
            // inside the panel's max height so the foot never paints over it.
            'fixed z-50 grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-background shadow-[0_12px_32px_rgba(0,0,0,0.10)] focus:outline-none',
            className,
          )}
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width: WIDTH,
            maxHeight: MAX_HEIGHT,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          <DialogPrimitive.Title className="sr-only">{t('picker_title')}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
