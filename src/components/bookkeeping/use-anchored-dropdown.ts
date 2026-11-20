import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  computeDropdownPosition,
  isSameDropdownPosition,
  type DropdownPosition,
} from '@/components/bookkeeping/account-combobox-position'

// Only stops propagation, so the browser's default scrolling still runs on
// the panel itself.
function stopScrollPropagation(e: Event) {
  e.stopPropagation()
}

/**
 * A dropdown panel portaled to document.body (so a scrollable dialog can
 * never clip it) and kept glued to its anchor: measured when it opens and
 * again while anything scrolls or the window resizes underneath it. The
 * capture-phase scroll listener also catches scrolling ancestors such as a
 * dialog's body. `preferredWidth` is the panel's width when the anchor is
 * narrower (see computeDropdownPosition).
 *
 * Returns the position (null until measured), the same as a `position:
 * fixed` style, the panel's ref for outside-click checks, and `attachPanel`,
 * the ref callback to put on the panel.
 */
export function useAnchoredDropdown(anchorRef: RefObject<HTMLElement | null>, open: boolean, preferredWidth?: number) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<DropdownPosition | null>(null)

  const update = useCallback(() => {
    if (!anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const next = computeDropdownPosition(
      { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      { width: window.innerWidth, height: window.innerHeight },
      { preferredWidth },
    )
    // Bail out when nothing moved (scroll ticks that did not shift the
    // anchor): returning the previous reference lets React skip the re-render.
    setPos((prev) => (isSameDropdownPosition(prev, next) ? prev : next))
  }, [anchorRef, preferredWidth])

  useLayoutEffect(() => {
    if (!open) return
    update()
    const handleScroll = (e: Event) => {
      // Scrolling the panel's own list never moves the anchor (the panel is
      // position: fixed): repositioning on it would only churn state.
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return
      update()
    }
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', update)
    }
  }, [open, update])

  // react-remove-scroll (active inside every modal dialog) preventDefaults
  // wheel/touchmove events that reach document from outside the dialog's DOM
  // tree, and the portaled panel lives outside that tree. Stopping the events
  // at the panel lets the browser scroll it natively; overscroll-contain on
  // the panel stops chained page scrolling at the list's edges.
  const attachPanel = useCallback((el: HTMLDivElement | null) => {
    const prev = panelRef.current
    if (prev) {
      prev.removeEventListener('wheel', stopScrollPropagation)
      prev.removeEventListener('touchmove', stopScrollPropagation)
    }
    panelRef.current = el
    if (el) {
      el.addEventListener('wheel', stopScrollPropagation)
      el.addEventListener('touchmove', stopScrollPropagation)
    }
  }, [])

  const style: CSSProperties | undefined = pos
    ? { left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }) }
    : undefined

  return { pos, style, panelRef, attachPanel }
}
