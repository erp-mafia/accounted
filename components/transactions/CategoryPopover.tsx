'use client'

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/**
 * Shell v2 category picker (Kick-style): the template list opens beside the
 * chip that was clicked instead of in a modal over the page. A fixed panel
 * placed from the anchor's rectangle, kept inside the viewport, closed by
 * Escape, a click outside, or a resize. The content is three children (a
 * head, the list, a foot); the transactions page passes the same
 * TemplatePicker the dialog shows, in its dense mode, as the list.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchor?.contains(target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [anchor, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      className={cn(
        // Three rows: head, the scrolling list, foot. A grid keeps the list
        // inside the panel's max height so the foot never paints over it.
        'fixed z-50 grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-background shadow-[0_12px_32px_rgba(0,0,0,0.10)]',
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
      {children}
    </div>,
    document.body,
  )
}
