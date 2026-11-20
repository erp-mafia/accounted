/**
 * The focus view's movement: where you are in the queue ("2 av 6"), which
 * item is next, which opens by itself when the focused one leaves the
 * queue, what a key does and where a swipe lands.
 *
 * Pure: the page passes ids and numbers in, gets ids and steps out.
 */

/** 1-based position for "N av M"; null when the id is not in the queue. */
export function focusPosition(queue: readonly string[], id: string | null): { index: number; total: number } | null {
  if (!id) return null
  const at = queue.indexOf(id)
  return at < 0 ? null : { index: at + 1, total: queue.length }
}

/** The item one step away (1 = next, -1 = previous), or null at either end. */
export function neighbour(queue: readonly string[], id: string, step: 1 | -1): string | null {
  const at = queue.indexOf(id)
  if (at < 0) return null
  return queue[at + step] ?? null
}

/**
 * What the focus view shows after the queue changed (an action finished, a
 * realtime refetch landed):
 *   - the focused item, while it is still in the queue;
 *   - otherwise the first item after it (in the old order) that is still
 *     there: you finished one, the next opens by itself;
 *   - otherwise the nearest one before it, when it was the last;
 *   - otherwise nothing, and the page goes back to the list.
 *
 * Walking the old order, not an index, keeps the choice right when other
 * items left or arrived in the same refetch.
 */
export function focusAfterChange(previous: readonly string[], next: readonly string[], focusedId: string): string | null {
  const present = new Set(next)
  if (present.has(focusedId)) return focusedId
  const at = previous.indexOf(focusedId)
  if (at < 0) return next[0] ?? null
  for (let i = at + 1; i < previous.length; i++) if (present.has(previous[i])) return previous[i]
  for (let i = at - 1; i >= 0; i--) if (present.has(previous[i])) return previous[i]
  return null
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

export type FocusKeyAction = 'next' | 'previous' | 'back'

export interface FocusKeyInput {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  /** The key went to a text field, a select or an editable region. */
  targetIsEditable: boolean
  /** A dialog or menu is open over the page: its keys are its own. */
  overlayOpen: boolean
}

/**
 * The focus view's keys: J or the right arrow for the next item, K or the
 * left arrow for the previous one, Esc back to the list. Nothing while
 * typing, while a dialog is open, or with a modifier held (Cmd+K is the
 * command palette).
 */
export function focusKeyAction(input: FocusKeyInput): FocusKeyAction | null {
  if (input.targetIsEditable || input.overlayOpen) return null
  if (input.metaKey || input.ctrlKey || input.altKey) return null
  switch (input.key) {
    case 'j':
    case 'J':
    case 'ArrowRight':
      return 'next'
    case 'k':
    case 'K':
    case 'ArrowLeft':
      return 'previous'
    case 'Escape':
      return 'back'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Swipe (phone)
// ---------------------------------------------------------------------------

/** How far ahead a flick's velocity carries, in seconds: the momentum decides, not only the distance. */
const PROJECTION_SECONDS = 0.2
/** The share of the stage's width a projected swipe has to cross to move on. */
const SWIPE_THRESHOLD = 0.3

export interface SwipeInput {
  /** Horizontal distance the finger moved, px (negative: to the left). */
  offset: number
  /** Horizontal velocity at release, px/s. */
  velocity: number
  /** The stage's width, px. */
  width: number
  canPrevious: boolean
  canNext: boolean
}

/**
 * Where a released swipe lands: 1 (next, swiped left), -1 (previous, swiped
 * right) or 0 (back to where it was). The release point is projected by the
 * velocity, so a short fast flick moves on and a long slow drag that is let
 * go halfway does not. At the first or last item it always springs back.
 */
export function swipeStep(input: SwipeInput): 1 | -1 | 0 {
  if (!(input.width > 0)) return 0
  const projected = input.offset + input.velocity * PROJECTION_SECONDS
  if (Math.abs(projected) <= input.width * SWIPE_THRESHOLD) return 0
  if (projected < 0) return input.canNext ? 1 : 0
  return input.canPrevious ? -1 : 0
}
