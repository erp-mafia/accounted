'use client'

import type { ReactNode } from 'react'
import { FloatingBulkBar } from '@/components/ui/floating-bulk-bar'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { BulkSelection } from '@/lib/hooks/use-bulk-selection'

interface BulkSelectionBarProps {
  selection: BulkSelection
  /** How many rows a select-all would pick (the visible selectable rows). */
  selectableCount: number
  /** The noun after the count, e.g. "fakturor valda". */
  countLabel: string
  /** "Markera alla (N)": shown while something visible is still unpicked. */
  selectAllLabel: string
  clearLabel: string
  /** The list's own actions, between the count and the select links. */
  children: ReactNode
}

/**
 * The bulk bar of a list on useBulkSelection: the pruned count, the list's
 * actions, "Markera alla" while there is more to pick, and "Rensa". Renders
 * nothing while nothing is selected.
 */
export function BulkSelectionBar({
  selection,
  selectableCount,
  countLabel,
  selectAllLabel,
  clearLabel,
  children,
}: BulkSelectionBarProps) {
  const count = selection.selectedIds.size
  if (count === 0) return null
  return (
    <FloatingBulkBar>
      <span className="whitespace-nowrap">
        <strong className="font-semibold tabular-nums">{count}</strong> {countLabel}
      </span>
      {children}
      {/* Hidden when everything visible is picked: "Markera alla" would do nothing. */}
      {selectableCount > 0 && !selection.allSelected && (
        <button type="button" className={QUIET_LINK_CLASS} onClick={selection.selectAll}>
          {selectAllLabel}
        </button>
      )}
      <button type="button" className={QUIET_LINK_CLASS} onClick={selection.clear}>
        {clearLabel}
      </button>
    </FloatingBulkBar>
  )
}
