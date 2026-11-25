import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { registrationOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { roundOre } from '@/lib/money'

/** The reskontra facts of an invoice or credit note the rule reads (get_ar_ledger_invoices). */
export interface IssueRoundingFacts {
  total: number | string | null
  currency: string | null
  deduction_total: number | string | null
  /** What its posted verifikat carries on 151x, 1513 aside; null when not SEK or not posted. */
  registered_receivable_sek?: number | string | null
}

function share(inv: IssueRoundingFacts): number {
  return Math.max(0, Number(inv.deduction_total) || 0)
}

/**
 * The öresavrundning the row's issue verifikat put on 1510
 * (registrationOreRounding): 0.25 for 999,75 issued as 1 000, -0.25 for its
 * full credit note, 0 for a row booked at the exact total (every invoice
 * issued before the issue verifikat booked the öre), a foreign row, or one
 * the ledger cannot say for.
 */
export function issueRoundingOf(inv: IssueRoundingFacts): number {
  if (!isLedgerCurrency(inv.currency) || inv.registered_receivable_sek == null) return 0
  return registrationOreRounding(
    roundOre((Number(inv.total) || 0) - share(inv)),
    Number(inv.registered_receivable_sek),
  )
}

/**
 * The row's own receivable with the öresavrundning its issue verifikat
 * booked, for as long as the customer's part is open: 1510 carries the
 * rounded amount until a settlement clears it, and every settlement door
 * clears what 1510 carries (bookedOreRounding), so the reskontra owes the
 * same. `outstanding` is total less what was paid, in invoice currency,
 * before Skatteverket's payouts (ROT/RUT share included). Once the customer's
 * part is settled, what is left is Skatteverket's share and the öre is gone
 * from 1510.
 */
export function withIssueRounding(inv: IssueRoundingFacts, outstanding: number): number {
  if (roundOre(outstanding - share(inv)) === 0) return outstanding
  const rounding = issueRoundingOf(inv)
  return rounding === 0 ? outstanding : roundOre(outstanding + rounding)
}
