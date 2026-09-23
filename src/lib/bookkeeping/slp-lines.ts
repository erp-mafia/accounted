// Särskild löneskatt på pensionskostnader (SLP), SLF 1991:687.
//
// Leaf module (only lib/money + types) so the booking engine, the API routes,
// the client-side supplier-invoice form/preview, and the bokslut calculator
// can all share the rate and the line pair without dragging server-only
// dependencies into client bundles.

import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/** Särskild löneskatt på pensionskostnader. 24.26 % per SLF 1991:687. */
export const SLP_RATE = 0.2426

/**
 * Accounts whose costs carry SLP when flagged on a supplier invoice line:
 * BAS 7410-7419 (pensionsförsäkringspremier m.m.). The same range the
 * bokslut calculator reads as the year-end SLP base
 * (lib/bokslut/tax-provision/sarskild-loneskatt-calculator.ts).
 */
export function isSlpPensionAccount(accountNumber: string): boolean {
  return /^741\d$/.test(accountNumber)
}

/**
 * Build the self-balancing SLP pair for a pension-premium base (SEK):
 *
 *   Debit  7533 Särskild löneskatt för pensionskostnader     [base x 24.26 %]
 *   Credit 2514 Beräknad särskild löneskatt pensionskostnader [same amount]
 *
 * The pair nets to zero, so injecting it into a supplier-invoice verifikat
 * never moves the payable (2440): the same mechanism reverse-charge fiktiv
 * moms uses to book beyond the payable. Returns [] for a non-positive base
 * or when rounding produces a zero amount.
 */
export function generateSlpLines(baseSek: number): CreateJournalEntryLineInput[] {
  if (baseSek <= 0) return []
  const amount = roundOre(baseSek * SLP_RATE)
  if (amount <= 0) return []
  const desc = 'Särskild löneskatt på pensionskostnader (24,26 %)'
  return [
    {
      account_number: '7533',
      debit_amount: amount,
      credit_amount: 0,
      line_description: desc,
    },
    {
      account_number: '2514',
      debit_amount: 0,
      credit_amount: amount,
      line_description: desc,
    },
  ]
}
