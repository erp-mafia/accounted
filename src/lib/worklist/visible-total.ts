import type { WorklistCounts } from './types'

/**
 * The "Att göra" total as the user actually sees it. The raw worklist total
 * counts inbox_document, but the Dokumentinkorg is a paid (AI) surface hidden
 * from non-payers, so its documents must not inflate the count either, else the
 * dashboard tile shows "N att göra" over a section that renders no such row.
 *
 * Single source for the KPI tile (DashboardContent) and the section header
 * (AttGoraSection): both must agree, and a mismatch here was a real bug. `extra`
 * carries dashboard-only additions (expiring bank connections) that are not a
 * lib/worklist category.
 */
export function visibleWorklistTotal(params: {
  total: number
  inboxDocumentCount: number
  hasAi: boolean
  extra?: number
}): number {
  const { total, inboxDocumentCount, hasAi, extra = 0 } = params
  // total already includes inbox_document, so the subtraction is >= 0 in normal
  // operation; clamp anyway so a transient count skew can never render a
  // nonsense negative "N att gora" on the dashboard tile.
  return Math.max(0, total + extra - (hasAi ? 0 : inboxDocumentCount))
}

/** Convenience overload taking the whole counts object. */
export function visibleWorklistTotalFrom(
  worklist: WorklistCounts,
  hasAi: boolean,
  extra = 0,
): number {
  return visibleWorklistTotal({
    total: worklist.total,
    inboxDocumentCount: worklist.counts.inbox_document,
    hasAi,
    extra,
  })
}
