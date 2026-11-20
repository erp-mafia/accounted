import type { ReactNode } from 'react'

/**
 * How long a toast stays before it leaves by itself.
 *
 * Every toast used to stay the Radix default of 5 s, and people working down
 * a list closed each "Godkänt" / "Bokfört" by hand to get the corner back.
 * A plain confirmation now leaves after 3 s, plus reading time for longer
 * text, and never stays longer than before. Everything that needs its time
 * keeps the 5 s: an error, a toast with a button (undo, open, retry), and
 * text this function cannot measure. A call site that passes its own
 * `duration` is not affected (use-toast.tsx only asks here when none is set).
 *
 * The timer pauses while the pointer is over the toast, while focus is
 * inside it, and while the window is in the background: Radix does that for
 * every duration, so a short toast can still be held for as long as needed.
 */

/** The Radix default, and what every toast used before. */
export const TOAST_DEFAULT_MS = 5000
/** Floor for any toast: long enough to read a short confirmation. */
export const TOAST_MIN_MS = 3000
/** Text up to this length is read within the floor. */
const SHORT_TEXT_CHARS = 40
/** Extra time per character beyond that (about 20 characters a second). */
const MS_PER_EXTRA_CHAR = 50

export interface ToastDurationInput {
  variant?: string | null
  title?: ReactNode
  description?: ReactNode
  hasAction?: boolean
}

/**
 * Characters of plain text in a toast node, or null when it holds something
 * that is not plain text (an element, an object) and so cannot be measured.
 */
export function toastTextLength(node: ReactNode): number | null {
  if (node == null || typeof node === 'boolean') return 0
  if (typeof node === 'string') return node.trim().length
  if (typeof node === 'number') return String(node).length
  if (Array.isArray(node)) {
    let total = 0
    for (const child of node) {
      const length = toastTextLength(child as ReactNode)
      if (length === null) return null
      total += length
    }
    return total
  }
  return null
}

export function toastDurationMs({ variant, title, description, hasAction }: ToastDurationInput): number {
  if (variant === 'destructive' || hasAction) return TOAST_DEFAULT_MS

  const titleLength = toastTextLength(title)
  const descriptionLength = toastTextLength(description)
  if (titleLength === null || descriptionLength === null) return TOAST_DEFAULT_MS

  const extraChars = Math.max(0, titleLength + descriptionLength - SHORT_TEXT_CHARS)
  return Math.min(TOAST_DEFAULT_MS, TOAST_MIN_MS + extraChars * MS_PER_EXTRA_CHAR)
}
