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
