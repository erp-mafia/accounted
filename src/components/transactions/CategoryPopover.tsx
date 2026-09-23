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
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number; width: number } | null>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      // Below the anchor when there is room for a useful list, else above;
      // the panel shrinks to the side it lands on instead of covering the
      // anchor, so it works from a button low in a tall form too.
      const spaceBelow = window.innerHeight - MARGIN - (r.bottom + GAP)
      const spaceAbove = r.top - GAP - MARGIN
      const useBelow = spaceBelow >= Math.min(MAX_HEIGHT, 320) || spaceBelow >= spaceAbove
      const maxHeight = Math.max(160, Math.min(MAX_HEIGHT, useBelow ? spaceBelow : spaceAbove))
      const height = Math.min(maxHeight, panelRef.current?.offsetHeight ?? maxHeight)
      const top = useBelow ? r.bottom + GAP : Math.max(MARGIN, r.top - GAP - height)
      // A phone is narrower than the panel: it takes the width that is there.
      const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN)
      const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN))
      setPos({ top, left, maxHeight, width })
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
            width: pos?.width ?? WIDTH,
            maxHeight: pos?.maxHeight ?? MAX_HEIGHT,
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
