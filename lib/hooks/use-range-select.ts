'use client'

import { useCallback, useRef } from 'react'

/**
 * Gmail-style shift-click range selection for list rows.
 *
 * Plain click toggles one row and becomes the anchor. Shift-click applies the
 * clicked row's NEW state to every row between the anchor and the target, in
 * the order the rows are currently rendered (so the range follows what the
 * user sees after filtering, sorting and paging, not the underlying data
 * order).
 */

/**
 * Pure range rule, extracted from the hook so it is testable without a
 * browser. Returns the next selection.
 *
 * `visibleIds` must be the rendered order. When the anchor is missing (first
 * click, or the anchor scrolled out of the current filter/page) a shift-click
 * degrades to a plain toggle, which is what every mail client does.
 *
 * An EMPTY selection also counts as having no anchor: every list clears the
 * selection from several places (a clear button, a filter change, a finished
 * bulk action), and a range measured from a row the user can no longer see
 * selected would sweep in dozens of rows they never picked. Anchoring on the
 * selection rather than on the clear call sites keeps that true for clear
 * paths nobody remembered to wire up.
 */
export function applyRangeSelection({
  selectedIds,
  visibleIds,
  anchorId,
  targetId,
  extend,
}: {
  selectedIds: Set<string>
  visibleIds: string[]
  anchorId: string | null
  targetId: string
  extend: boolean
}): Set<string> {
  const next = new Set(selectedIds)
  const shouldSelect = !selectedIds.has(targetId)

  const anchorIndex =
    anchorId === null || selectedIds.size === 0 ? -1 : visibleIds.indexOf(anchorId)
  const targetIndex = visibleIds.indexOf(targetId)

  if (!extend || anchorIndex === -1 || targetIndex === -1) {
    if (shouldSelect) next.add(targetId)
    else next.delete(targetId)
    return next
  }

  const from = Math.min(anchorIndex, targetIndex)
  const to = Math.max(anchorIndex, targetIndex)
  for (let i = from; i <= to; i++) {
    if (shouldSelect) next.add(visibleIds[i])
    else next.delete(visibleIds[i])
  }
  return next
}

export interface UseRangeSelectOptions {
  /** Row ids in the order they are rendered right now. */
  visibleIds: string[]
  selectedIds: Set<string>
  setSelectedIds: (next: Set<string>) => void
}

export interface UseRangeSelect {
  /** Toggle one row; pass shiftKey from the click event to extend the range. */
  toggle: (id: string, extend?: boolean) => void
  /** Drop the anchor, e.g. after select-all or clear. */
  resetAnchor: () => void
}

export function useRangeSelect({
  visibleIds,
  selectedIds,
  setSelectedIds,
}: UseRangeSelectOptions): UseRangeSelect {
  const anchorRef = useRef<string | null>(null)

  const toggle = useCallback(
    (id: string, extend = false) => {
      setSelectedIds(
        applyRangeSelection({
          selectedIds,
          visibleIds,
          anchorId: anchorRef.current,
          targetId: id,
          extend,
        }),
      )
      anchorRef.current = id
    },
    [selectedIds, visibleIds, setSelectedIds],
  )

  const resetAnchor = useCallback(() => {
    anchorRef.current = null
  }, [])

  return { toggle, resetAnchor }
}
