/**
 * Pure ROT/RUT refused-share arithmetic, kept free of server and bookkeeping
 * imports so client components (the ROT/RUT overview page) can use it.
 */
import { roundOre } from '@/lib/money'

export interface RefusedShare {
  itemId: string
  invoiceId: string
  refused: number
}

/**
 * Pure: the refused share per item from the recorded beslut, or the reason
 * it cannot be known. Exported for the overview page, which shows "nekat att
 * bokföra" per request without booking anything.
 */
export function computeRefusedShares(
  request: {
    requested_total: number | string
    decided_total: number | string | null
    decided_at: string | null
  },
  items: Array<{
    id: string
    invoice_id: string
    requested_amount: number | string
    decided_amount: number | string | null
  }>,
):
  | { ok: true; shares: RefusedShare[]; total: number }
  | { ok: false; code: 'ROT_RUT_RECLAIM_NO_BESLUT' | 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' } {
  if (!request.decided_at || request.decided_total == null) {
    return { ok: false, code: 'ROT_RUT_RECLAIM_NO_BESLUT' }
  }
  const decidedTotal = roundOre(Number(request.decided_total))
  const requestedTotal = roundOre(Number(request.requested_total))
  const fullRefusal = decidedTotal <= 0

  const shares: RefusedShare[] = []
  for (const item of items) {
    const requested = roundOre(Number(item.requested_amount))
    let decided: number
    if (fullRefusal) {
      decided = 0
    } else if (item.decided_amount != null) {
      decided = roundOre(Number(item.decided_amount))
    } else if (items.length === 1) {
      // One ärende: the request total IS the item's beslut.
      decided = decidedTotal
    } else {
      return { ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' }
    }
    const refused = roundOre(Math.max(0, Math.min(requested, requested - decided)))
    shares.push({ itemId: item.id, invoiceId: item.invoice_id, refused })
  }
  // The per-item shares ARE what gets booked, so they must reconcile with the
  // request-level beslut to the öre. Items decided at less than the header
  // says (or more) mean the recorded beslut is inconsistent: refuse, never
  // book legs that sum to something else than the refused total.
  const total = roundOre(shares.reduce((sum, s) => sum + s.refused, 0))
  const refusedByHeader = roundOre(Math.max(0, requestedTotal - decidedTotal))
  if (Math.abs(total - refusedByHeader) > 0.005) {
    return { ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' }
  }
  return { ok: true, shares, total }
}
