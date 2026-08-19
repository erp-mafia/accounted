/**
 * Pure positioning for AccountCombobox's portaled (non-flat) dropdown.
 *
 * The non-flat dropdown renders on document.body (see AccountCombobox) so a
 * scrollable DialogContent can never clip it or grow a horizontal scrollbar
 * around it. That trades CSS anchoring (absolute + top-full) for explicit
 * viewport math, which lives here so it can be unit-tested headlessly.
 *
 * All numbers are CSS pixels in viewport coordinates (getBoundingClientRect
 * space), matching position: fixed.
 */

export interface DropdownAnchorRect {
  top: number
  bottom: number
  left: number
  width: number
}

export interface DropdownViewportSize {
  width: number
  height: number
}

export interface DropdownPosition {
  left: number
  width: number
  maxHeight: number
  /** Set when the dropdown opens below the anchor (CSS `top`). */
  top?: number
  /**
   * Set when the dropdown opens above the anchor (CSS `bottom`, measured from
   * the viewport bottom). Anchoring by `bottom` lets the panel grow upward
   * without knowing its own height.
   */
  bottom?: number
}

/** 34rem: wide enough for account number + name + activation marker. */
export const DROPDOWN_PREFERRED_WIDTH = 544
/** Minimum gap kept between the dropdown and every viewport edge. */
export const DROPDOWN_VIEWPORT_MARGIN = 8
/** Gap between the anchor (trigger) and the dropdown. */
export const DROPDOWN_ANCHOR_GAP = 4
/** The dropdown's own scroll ceiling (was max-h-[300px] pre-portal). */
export const DROPDOWN_MAX_HEIGHT = 300
/** Below this much room the dropdown flips above the anchor instead. */
const MIN_USEFUL_HEIGHT = 120
/** Height floor so a cramped viewport still shows a scrollable list. */
const HEIGHT_FLOOR = 96

/**
 * Shallow equality over the full position shape. The scroll/resize reposition
 * handler uses this to skip setState when the recomputed geometry is
 * unchanged (e.g. scroll events that did not move the anchor), so React does
 * not re-render the open dropdown on every scroll tick.
 */
export function isSameDropdownPosition(
  a: DropdownPosition | null,
  b: DropdownPosition,
): boolean {
  return (
    a !== null &&
    a.left === b.left &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight &&
    a.top === b.top &&
    a.bottom === b.bottom
  )
}

export function computeDropdownPosition(
  anchor: DropdownAnchorRect,
  viewport: DropdownViewportSize,
): DropdownPosition {
  const margin = DROPDOWN_VIEWPORT_MARGIN
  const maxWidth = Math.max(viewport.width - margin * 2, 0)
  const width = Math.min(Math.max(anchor.width, DROPDOWN_PREFERRED_WIDTH), maxWidth)
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin))

  const spaceBelow = viewport.height - anchor.bottom - DROPDOWN_ANCHOR_GAP - margin
  const spaceAbove = anchor.top - DROPDOWN_ANCHOR_GAP - margin
  const openUp = spaceBelow < MIN_USEFUL_HEIGHT && spaceAbove > spaceBelow

  const available = openUp ? spaceAbove : spaceBelow
  const maxHeight = Math.min(DROPDOWN_MAX_HEIGHT, Math.max(available, HEIGHT_FLOOR))

  if (openUp) {
    return { left, width, maxHeight, bottom: viewport.height - anchor.top + DROPDOWN_ANCHOR_GAP }
  }
  return { left, width, maxHeight, top: anchor.bottom + DROPDOWN_ANCHOR_GAP }
}
