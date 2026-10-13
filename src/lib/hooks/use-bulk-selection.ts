'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRangeSelect } from '@/lib/hooks/use-range-select'

/**
 * The rows a bulk action may act on: the selection, cut to the rows the list
 * can act on right now. A row a filter, tab, search or refetch hid drops out,
 * so "Bokför 12" never books rows the user can no longer see.
 */
export function pruneSelection(selected: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const id of visibleIds) if (selected.has(id)) out.add(id)
  return out
}

export interface BulkSelection {
  /** The selection, pruned to `visibleIds`: what a bulk action acts on. */
  selectedIds: Set<string>
  /** Toggle one row; pass shiftKey to extend the range (useRangeSelect). */
  toggle: (id: string, extend?: boolean) => void
  selectAll: () => void
  /** Replace the selection with these rows (those of them that are visible). */
  selectOnly: (ids: Iterable<string>) => void
  /** Drop these rows, e.g. one approved or deleted before the refetch lands. */
  deselect: (ids: Iterable<string>) => void
  clear: () => void
  /** Every visible row is selected (false when there are none). */
  allSelected: boolean
  /** The header checkbox: checked, indeterminate or not. */
  headerState: boolean | 'indeterminate'
}

/**
 * One bulk selection for a list: shift-click ranges, select all, clear, and a
 * selection that only ever holds rows the user can see and act on.
 *
 * `visibleIds` is the selectable rows the current view holds. A row that
 * leaves it leaves the selection: it is not counted, not acted on, and does
 * not come back selected when the view does. `rangeIds`, when the list
 * renders only part of the view ("Visa fler"), is the rendered part in
 * order: shift-click ranges walk what is on screen, select-all takes the
 * whole view.
 */
export function useBulkSelection(
  visibleIds: readonly string[],
  options: { rangeIds?: readonly string[] } = {},
): BulkSelection {
  // Keyed on the ids' contents, not the array: lists rebuild visibleIds on
  // every render, and a new Set each time would re-run every effect that
  // depends on the selection.
  const visibleKey = visibleIds.join('\u0000')
  const visible = useMemo(() => (visibleKey === '' ? [] : visibleKey.split('\u0000')), [visibleKey])

  const [state, setState] = useState<{ key: string; ids: Set<string> }>(() => ({ key: visibleKey, ids: new Set() }))
  // When the visible rows change (a filter, a tab, a page, a refetch) the
  // rows that left drop out of the selection for good, during this render
  // (React's "adjust state when a prop changes"), so going back to the old
  // view does not bring an invisible selection back either.
  let selectedIds = state.ids
  if (state.key !== visibleKey) {
    selectedIds = pruneSelection(state.ids, visible)
    setState({ key: visibleKey, ids: selectedIds })
  }

  const setIds = useCallback((ids: Set<string>) => setState((prev) => ({ key: prev.key, ids })), [])
  const rangeKey = options.rangeIds ? options.rangeIds.join('\u0000') : visibleKey
  const rangeIds = useMemo(() => (rangeKey === '' ? [] : rangeKey.split('\u0000')), [rangeKey])
  const { toggle, resetAnchor } = useRangeSelect({ visibleIds: rangeIds, selectedIds, setSelectedIds: setIds })

  const selectAll = useCallback(() => {
    setIds(new Set(visible))
    resetAnchor()
  }, [visible, setIds, resetAnchor])

  const selectOnly = useCallback(
    (ids: Iterable<string>) => {
      setIds(pruneSelection(new Set(ids), visible))
      resetAnchor()
    },
    [visible, setIds, resetAnchor],
  )

  const deselect = useCallback(
    (ids: Iterable<string>) => {
      const drop = new Set(ids)
      setState((prev) => {
        if (![...drop].some((id) => prev.ids.has(id))) return prev
        return { key: prev.key, ids: new Set([...prev.ids].filter((id) => !drop.has(id))) }
      })
    },
    [],
  )

  const clear = useCallback(() => {
    setIds(new Set())
    resetAnchor()
  }, [setIds, resetAnchor])

  const allSelected = visible.length > 0 && selectedIds.size === visible.length
  const headerState: boolean | 'indeterminate' = allSelected ? true : selectedIds.size > 0 ? 'indeterminate' : false

  return { selectedIds, toggle, selectAll, selectOnly, deselect, clear, allSelected, headerState }
}
