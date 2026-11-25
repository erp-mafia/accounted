'use client'

import { useLayoutEffect, useSyncExternalStore, type CSSProperties } from 'react'

/**
 * The visual viewport: what is actually visible. An on-screen keyboard and a
 * pinch zoom shrink it; the layout viewport, which `position: fixed`, 100dvh
 * and window.innerHeight measure from, stays as it was. On iOS Safari (and
 * Chrome on Android, which resizes only the visual viewport by default) a
 * dialog placed against the layout viewport therefore keeps its lower part,
 * the footer with its primary, under the keyboard.
 *
 * The shared DialogContent and SlideOverContent read the visible box as two
 * custom properties (dialogViewportStyle). They set it themselves while an
 * on-screen keyboard covers part of the screen on a touch device
 * (useKeyboardFit); the support dialog sets it whenever it is open.
 */

export interface ViewportBox {
  height: number
  offsetTop: number
}

let cachedBox: ViewportBox | null = null

function readViewport(): ViewportBox | null {
  const vv = typeof window === 'undefined' ? null : window.visualViewport
  if (!vv) return null
  if (!cachedBox || cachedBox.height !== vv.height || cachedBox.offsetTop !== vv.offsetTop) {
    cachedBox = { height: vv.height, offsetTop: vv.offsetTop }
  }
  return cachedBox
}

function subscribeViewport(onChange: () => void): () => void {
  const vv = window.visualViewport
  if (!vv) return () => {}
  vv.addEventListener('resize', onChange)
  vv.addEventListener('scroll', onChange)
  return () => {
    vv.removeEventListener('resize', onChange)
    vv.removeEventListener('scroll', onChange)
  }
}

const noSubscription = () => () => {}
const noViewport = () => null

/**
 * The visual viewport (what is actually visible: the keyboard and a pinch
 * zoom shrink it) while `active`, else null. Inactive subscribes to nothing,
 * so a closed dialog's trigger does not re-render on every viewport change.
 */
export function useVisualViewport(active: boolean): ViewportBox | null {
  return useSyncExternalStore(
    active ? subscribeViewport : noSubscription,
    active ? readViewport : noViewport,
    noViewport,
  )
}

/**
 * The visual viewport, handed to the shared DialogContent (and
 * SlideOverContent) as the two custom properties its own placement reads
 * (components/ui/dialog.tsx, components/ui/slide-over.tsx): the layer keeps
 * its normal top anchor, measured from the top of what is visible, and its
 * max height counts from the visible height. No `top` and no `maxHeight` of
 * our own. With nothing offset or shrunk the result equals the default
 * placement.
 */
export function dialogViewportStyle(box: ViewportBox | null): CSSProperties | undefined {
  if (!box) return undefined
  return {
    '--dialog-viewport-top': `${box.offsetTop}px`,
    '--dialog-viewport-height': `${box.height}px`,
  } as CSSProperties
}

/**
 * How much of the layout viewport, in px, must be out of sight before it
 * counts as covered by an on-screen keyboard. A phone keyboard covers several
 * hundred px; less than this is rounding or browser chrome, and leaves the
 * placement alone.
 */
export const KEYBOARD_MIN_COVER = 48

/**
 * Whether an on-screen keyboard covers part of the layout viewport. A pinch
 * zoom shrinks the visual viewport too, but by the zoom: height times scale
 * stays the layout height, so zooming alone never counts. With a keyboard up
 * the visible part, zoomed or not, is shorter by the keyboard.
 */
export function keyboardCovers(layoutHeight: number, visible: { height: number; scale: number }): boolean {
  return layoutHeight - visible.height * visible.scale > KEYBOARD_MIN_COVER
}

let coarseQuery: MediaQueryList | null = null

function coarsePointer(): boolean {
  if (typeof window.matchMedia !== 'function') return false
  coarseQuery ??= window.matchMedia('(pointer: coarse)')
  return coarseQuery.matches
}

function readKeyboardViewport(): ViewportBox | null {
  const vv = window.visualViewport
  // A mouse or trackpad first: no on-screen keyboard, so nothing is measured.
  if (!vv || !coarsePointer()) return null
  return keyboardCovers(document.documentElement.clientHeight, vv) ? readViewport() : null
}

/**
 * The visual viewport while `active`, on a touch screen, and only while an
 * on-screen keyboard covers part of the layout viewport; else null. Without
 * a keyboard, on a desktop, and while only zoomed it stays null, so a layer
 * reading it renders exactly as without it.
 */
export function useKeyboardViewport(active: boolean): ViewportBox | null {
  return useSyncExternalStore(
    active ? subscribeViewport : noSubscription,
    active ? readKeyboardViewport : noViewport,
    noViewport,
  )
}

/**
 * Where a scroll container scrolls to so a focused field shows after the
 * keyboard shrank the container: nowhere (null) while the field already sits
 * between the container's top and its middle, clear of a footer that sticks
 * to its bottom; else with the field in the middle, or its top at the top
 * when it is taller than the container.
 */
export function revealScrollTop(
  view: { top: number; height: number; scrollTop: number },
  field: { top: number; height: number },
): number | null {
  const offset = field.top - view.top
  if (offset >= 0 && offset + field.height <= view.height / 2) return null
  return Math.max(0, view.scrollTop + offset - Math.max(0, (view.height - field.height) / 2))
}

/** Marks a panel while useKeyboardFit fits it; the reveal looks for it. */
export const KEYBOARD_FIT_ATTRIBUTE = 'data-keyboard-fit'

/**
 * The field in focus, shown in the scroll area of the fitted panel around
 * it. The browser scrolled it into view before the keyboard shrank the panel,
 * so it can sit below the new edge or under the footer. Only the nearest
 * scroll container inside the panel moves, never the page; a field outside
 * every fitted panel (the assistant beside a dialog) is left alone.
 */
function revealFocusedField(): void {
  const field = document.activeElement
  if (!(field instanceof HTMLElement)) return
  const panel = field.parentElement?.closest(`[${KEYBOARD_FIT_ATTRIBUTE}]`)
  let scroller = panel ? field.parentElement : null
  while (scroller) {
    if (scroller.scrollHeight > scroller.clientHeight && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      const view = scroller.getBoundingClientRect()
      const rect = field.getBoundingClientRect()
      const next = revealScrollTop(
        { top: view.top, height: scroller.clientHeight, scrollTop: scroller.scrollTop },
        { top: rect.top, height: rect.height },
      )
      if (next !== null) scroller.scrollTop = next
      return
    }
    if (scroller === panel) return
    scroller = scroller.parentElement
  }
}

/**
 * For a dialog or drawer panel that is mounted only while it is open: the
 * caller's style plus the visible box while an on-screen keyboard is up on a
 * touch screen (useKeyboardViewport), so the panel and its scroll area end
 * above the keyboard and the footer with the primary stays in sight. `fitted`
 * says so; the panel then carries KEYBOARD_FIT_ATTRIBUTE. When the keyboard
 * comes up or changes height, the field in focus is shown inside the shrunk
 * panel. Without a keyboard the style is the caller's own, unchanged.
 */
export function useKeyboardFit(style?: CSSProperties): { style: CSSProperties | undefined; fitted: boolean } {
  const box = useKeyboardViewport(true)
  const height = box?.height
  useLayoutEffect(() => {
    if (height !== undefined) revealFocusedField()
  }, [height])
  const fit = dialogViewportStyle(box)
  return { style: fit ? { ...fit, ...style } : style, fitted: box !== null }
}
