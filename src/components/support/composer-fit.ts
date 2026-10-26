'use client'

import { useSyncExternalStore } from 'react'

/**
 * Sizing for the support dialog's message box (PH 216).
 *
 * The box was a fixed 120px textarea (80px for a reply) with resize-none:
 * about four lines of a message, the rest scrolled inside it behind an
 * overlay scrollbar Safari does not show, and no handle to drag it bigger.
 * Someone writing ten lines could not read back what they wrote. On an iPad
 * the on-screen keyboard also covered the lower half of a dialog centered in
 * the layout viewport: 100dvh does not shrink for the keyboard, only the
 * visual viewport does.
 *
 * Now the box grows with its text as far as the visible viewport allows with
 * the rest of the dialog still on screen, then scrolls inside, and the dialog
 * is centered in, and capped to, the visual viewport.
 */

/** Space kept between the dialog and the viewport edges, as DialogContent's max-h-[calc(100dvh-2rem)]. */
export const DIALOG_VIEWPORT_MARGIN_PX = 32

export interface ViewportBox {
  height: number
  offsetTop: number
}

export interface TextareaHeightInput {
  /** Height that shows every line: scrollHeight plus the border. */
  content: number
  /** Everything else in the dialog: header, footer, paddings, other rows. */
  chrome: number
  /** Visible viewport height (the visual viewport while a keyboard is up). */
  viewport: number
  /** The box's own min height, which it never goes under. */
  min: number
}

/**
 * The box shows all of its text while that fits beside the rest of the dialog
 * in the visible viewport, and stops growing there (its text scrolls inside).
 * A viewport too short for even the min height keeps the min: the dialog then
 * scrolls as a whole, which beats a box too small to type in.
 */
export function textareaHeight({ content, chrome, viewport, min }: TextareaHeightInput): number {
  const room = viewport - DIALOG_VIEWPORT_MARGIN_PX - chrome
  const cap = Math.max(min, room)
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
export function fitTextarea(el: FittableTextarea, panel: FitPanel | null, viewport: number): number {
  el.style.height = 'auto'
  const min = el.offsetHeight
  const content = el.scrollHeight + (el.offsetHeight - el.clientHeight)
  const chrome = panel ? Math.max(0, panel.scrollHeight - min) : 0
  const height = textareaHeight({ content, chrome, viewport, min })
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

/** Dialog placement inside the visual viewport: centered in it and capped to it. */
export function dialogViewportStyle(box: ViewportBox | null): { top: number; maxHeight: number } | undefined {
  if (!box) return undefined
  return {
    top: box.offsetTop + box.height / 2,
    maxHeight: Math.max(0, box.height - DIALOG_VIEWPORT_MARGIN_PX),
  }
}
