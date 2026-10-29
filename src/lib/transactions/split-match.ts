import { isZeroOre, ORE_ROUNDING_SETTLEMENT_MAX, roundOre, sumOre } from '@/lib/money'
import type { BatchAllocationPrefill } from './parts-read'

/**
 * Whether a bank row offers "Dela in-/utbetalningen på flera fakturor" (the
 * MatchAllocationDialog, POST /api/transactions/[id]/match-batch).
 *
 * Deliberately independent of the matcher's single-invoice suggestion
 * (`potential_invoice` / `potential_supplier_invoice`). One payment that
 * settles several equal invoices is exactly the case where the matcher still
 * finds ONE plausible candidate: gating the split on "no suggestion" hid the
 * only working path while the suggested 1-click match was rejected with
 * MATCH_AMOUNT_EXCEEDS_REMAINING.
 *
 * ROT/RUT payouts and utlägg repayments are different settlement kinds with
 * their own dialogs, so a row recognised as one of those keeps them.
 */
export function canOfferSplitMatch(row: {
  isUnbooked: boolean
  hasRotRutPayoutMatch: boolean
  hasExpensePayoutMatch: boolean
}): boolean {
  return row.isUnbooked && !row.hasRotRutPayoutMatch && !row.hasExpensePayoutMatch
}

/** One open invoice ticked in the invoice picker, in the bank row's currency. */
export interface PickedInvoice {
  kind: 'customer_invoice' | 'supplier_invoice'
  id: string
  /** What the invoice still owes, in the bank row's currency. */
  remaining: number
  /** ISO due date; the oldest is paid first. */
  dueDate: string | null
}

/**
 * How the ticked invoices meet the bank row, by the rules match_batch_allocate
 * books with (lib/invoices/batch-allocation-preview.ts mirrors them):
 *   exact         the invoices add up to the row;
 *   ore_rounding  under 1 kr apart: every invoice is settled in full and the
 *                 öre lands on 3740 (ORE_ROUNDING_SETTLEMENT_MAX);
 *   partial       the invoices owe more than the row: the oldest are paid in
 *                 full and the last one in part;
 *   over          even the last invoice would get nothing: one too many ticked;
 *   short         the row is larger: the rest has no invoice. It cannot be
 *                 booked until more invoices cover the row, or, on a supplier
 *                 payment, a fee row (the bank's charge) takes the rest.
 *                 A payout net of a fee is `partial` here: the dialog's
 *                 "Lägg till avgiftsrad" settles every invoice in full and
 *                 books the gap as the fee (lib/bookkeeping/payout-fee-lines.ts).
 */
export type PickedAllocationOutcome = 'exact' | 'ore_rounding' | 'partial' | 'over' | 'short'

export interface PickedAllocationPlan {
  /** Ready for the batch allocation dialog (MatchAllocationDialog initialAllocations). */
  allocations: BatchAllocationPrefill[]
  /** What the ticked invoices still owe together. */
  pickedTotal: number
  /** The row minus pickedTotal: positive when the row is larger. */
  difference: number
  outcome: PickedAllocationOutcome
  /** partial: the invoice the row pays only in part. */
  partiallyPaidId: string | null
}

function allocationOf(invoice: PickedInvoice, amount: number): BatchAllocationPrefill {
  return invoice.kind === 'customer_invoice'
    ? { kind: 'customer_invoice', invoice_id: invoice.id, amount }
    : { kind: 'supplier_invoice', supplier_invoice_id: invoice.id, amount }
}

/**
 * The allocation of one bank row across the invoices ticked in the picker,
 * so the batch dialog opens with amounts the server books as they stand:
 * the sum equals the row (BATCH_AMOUNT_BELOW_TX / _EXCEEDS_TX otherwise) and
 * no invoice takes a krona or more above what it owes (BATCH_OVERSHOOT).
 * Oldest due date first, like the dialog's own list. `over` and `short` keep
 * each invoice at what it owes; the dialog then shows the gap and blocks the
 * confirm until it is closed.
 */
export function planPickedAllocations(rowAmount: number, picked: readonly PickedInvoice[]): PickedAllocationPlan {
  const rowAbs = roundOre(Math.abs(rowAmount))
  const ordered = [...picked].sort((a, b) => {
    const da = a.dueDate ?? '9999-12-31'
    const db = b.dueDate ?? '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const pickedTotal = sumOre(ordered.map((invoice) => invoice.remaining))
  const difference = roundOre(rowAbs - pickedTotal)
  const asOwed = ordered.map((invoice) => allocationOf(invoice, roundOre(invoice.remaining)))
  const plan = (outcome: PickedAllocationOutcome, allocations = asOwed, partiallyPaidId: string | null = null) => ({
    allocations,
    pickedTotal,
    difference,
    outcome,
    partiallyPaidId,
  })

  if (ordered.length === 0) return plan('short', [])
  if (isZeroOre(difference)) return plan('exact')

  const last = ordered[ordered.length - 1]
  const lastAmount = roundOre(last.remaining + difference)
  if (Math.abs(difference) < ORE_ROUNDING_SETTLEMENT_MAX && lastAmount > 0) {
    // The RPC settles an invoice in full when its allocation is under 1 kr
    // off what it owes and books the residual on 3740, so the öre goes on the
    // last invoice and the sum still equals the row.
    return plan('ore_rounding', [...asOwed.slice(0, -1), allocationOf(last, lastAmount)])
  }
  if (difference > 0) return plan('short')
  // The invoices owe more than the row: the last one is paid in part, as long
  // as it still gets something.
  if (lastAmount > 0) return plan('partial', [...asOwed.slice(0, -1), allocationOf(last, lastAmount)], last.id)
  return plan('over')
}
