'use client'

import { useSyncExternalStore, type CSSProperties } from 'react'

/**
 * Sizing for the support dialog's message box (PH 216).
 *
 * The box was a fixed 120px textarea (80px for a reply) with resize-none:
 * about four lines of a message, the rest scrolled inside it behind an
 * overlay scrollbar Safari does not show, and no handle to drag it bigger.
 * Someone writing ten lines could not read back what they wrote. On an iPad
 * the on-screen keyboard also covered the lower half of the dialog: 100dvh
 * does not shrink for the keyboard, only the visual viewport does.
 *
 * Now the box grows with its text as far as the dialog's own max height
 * allows, then scrolls inside, and the dialog is told the visual viewport, so
 * it sits and ends inside what is actually visible.
 *
 * Nothing here knows where a dialog sits or how tall it may be: the shared
 * DialogContent owns that (components/ui/dialog.tsx). This module once kept
 * its own copy of that placement (the middle of the viewport, a 32px margin);
 * when dialogs became top anchored the copy put the dialog's top edge at the
 * middle of the screen and its lower half below it (crm#1973).
 */

export interface ViewportBox {
  height: number
  offsetTop: number
}

export interface TextareaHeightInput {
  /** Height that shows every line: scrollHeight plus the border. */
  content: number
  /** Everything else in the dialog: header, footer, paddings, other rows. */
  chrome: number
  /** The tallest the dialog may be right now: its own max height. */
  dialogMax: number
  /** The box's own min height, which it never goes under. */
  min: number
}

/**
 * The box shows all of its text while that fits beside the rest of the dialog
 * under the dialog's max height, and stops growing there (its text scrolls
 * inside). A dialog too short for even the min height keeps the min: the
 * dialog then scrolls as a whole, which beats a box too small to type in.
 */
export function textareaHeight({ content, chrome, dialogMax, min }: TextareaHeightInput): number {
  const cap = Math.max(min, dialogMax - chrome)
  return Math.min(Math.max(content, min), cap)
}

/** The parts of a textarea and its panel that fitting reads and writes. */
export interface FittableTextarea {
  style: { height: string; overflowY: string }
  readonly offsetHeight: number
  readonly clientHeight: number
  readonly scrollHeight: number
}

export interface FitPanel {
  readonly scrollHeight: number
}

/**
 * Sizes the textarea to its text within the room the panel leaves it.
 * Measured at height auto, where the box sits at its CSS min height, so the
 * panel's scrollHeight minus the box is the chrome around it. The inner
 * scrollbar only shows once the text is taller than the box: at an exact fit a
 * rounding pixel would otherwise draw an empty one.
 */
export function fitTextarea(el: FittableTextarea, panel: FitPanel | null, dialogMax: number): number {
  el.style.height = 'auto'
  const min = el.offsetHeight
  const content = el.scrollHeight + (el.offsetHeight - el.clientHeight)
  const chrome = panel ? Math.max(0, panel.scrollHeight - min) : 0
  const height = textareaHeight({ content, chrome, dialogMax, min })
  el.style.height = `${height}px`
  el.style.overflowY = content > height ? 'auto' : 'hidden'
  return height
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
 * The tallest the dialog may be right now, read from the dialog itself: its
 * max height is the shared DialogContent's to decide, and it already follows
 * the visual viewport (dialogViewportStyle). `fallback` answers before the
 * panel is mounted or when it has no max height.
 */
export function dialogMaxHeight(panel: Element | null, fallback: number): number {
  if (!panel) return fallback
  const max = parseFloat(getComputedStyle(panel).maxHeight)
  return Number.isFinite(max) ? max : fallback
}

/**
 * The visual viewport, handed to the shared DialogContent as the two custom
 * properties its own placement reads (components/ui/dialog.tsx): the dialog
 * keeps its normal top anchor, measured from the top of what is visible, and
 * its max height counts from the visible height. No `top` and no `maxHeight`
 * of our own. With nothing offset or shrunk the result equals the dialog's
 * default placement.
 */
export function dialogViewportStyle(box: ViewportBox | null): CSSProperties | undefined {
  if (!box) return undefined
  return {
    '--dialog-viewport-top': `${box.offsetTop}px`,
    '--dialog-viewport-height': `${box.height}px`,
  } as CSSProperties
}
