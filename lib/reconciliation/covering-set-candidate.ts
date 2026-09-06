import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectExplainingVoucherSets,
  type ExplainingVoucherSet,
} from '@/lib/invoices/duplicate-payment-detection'
import { createLogger } from '@/lib/logger'
import type { ReconciliationProposal } from './schemas'

const log = createLogger('reconciliation.covering-set-candidate')

/**
 * Covering-set proposals for the bridge table (#2293): a bank row nothing
 * matches 1:1 is searched for the unlinked verifikat on its account whose
 * bank legs sum exactly to it, BEFORE the row is offered as unmatched.
 *
 * Why: a Bankgirot daily aggregate arrives as one row for several
 * affärshändelser, each often already booked on its own ("Markera som
 * betald" per invoice, one salary voucher per employee). The 1:1 matcher
 * sees no voucher of the row's amount, the row reads "ej matchad", and the
 * next door (Bokför) books the money a second time. The booking doors have
 * refused that since #2300 and #2346 by running detectExplainingVoucherSet;
 * this runs the SAME detector (its batch form) in the read path so the view
 * stops steering users to the door the guard slams. One definition of
 * "explained by the ledger", at the doors and in the view.
 *
 * Read-time only, never persisted: the pool is the account's open rows
 * against its unlinked legs, and a stored hint would add a stale-pointer
 * class for no saving (the utlägg pairing precedent, DECISIONS 2026-09-05).
 * Never auto-applied: the unattended sweep persists and applies 1:1 matches
 * only, and use_proposals reads the persisted column. A set proposal is
 * confirmed per row through the ordinary 1:N link (linkTransactionToVouchers),
 * which revalidates every slice at click time.
 *
 * SEK accounts only. The detector sums in SEK; the 1:N link that confirms
 * the proposal compares in the account's own currency (ledgerLineAmountIn),
 * so on a EUR account a set that sums in SEK could be refused at confirm. A
 * proposal that cannot be confirmed is worse than none.
 */

/** Exact öre sum, every voucher dated on the row's date: as strong as auto_exact. */
export const COVERING_SET_SAME_DATE_CONFIDENCE = 0.95
/** Exact öre sum within ±7 days: as strong as auto_date_range, below the 0.9 unattended floor. */
export const COVERING_SET_WINDOW_CONFIDENCE = 0.85

/** The columns of an open bank row the search needs. */
export interface CoveringSetRow {
  id: string
  date: string
  amount: number
  currency: string | null
}

/** Pure: the proposal the bridge table renders for an explaining set. */
export function coveringSetProposal(set: ExplainingVoucherSet): ReconciliationProposal {
  const [first] = set.vouchers
  const descriptions = set.vouchers
    .map((v) => (v.description ?? '').trim())
    .filter((d) => d.length > 0)
  return {
    journal_entry_id: first.journal_entry_id,
    voucher_number: first.voucher_number,
    voucher_series: first.voucher_series,
    entry_date: first.entry_date,
    description: descriptions.join(' + '),
    entry_status: 'posted',
    confidence: set.same_date ? COVERING_SET_SAME_DATE_CONFIDENCE : COVERING_SET_WINDOW_CONFIDENCE,
    reasons: [set.same_date ? 'exact_sum_same_date' : 'exact_sum_within_window'],
    vouchers: set.vouchers.map((v) => ({
      journal_entry_id: v.journal_entry_id,
      voucher_number: v.voucher_number,
      voucher_series: v.voucher_series,
      entry_date: v.entry_date,
      description: v.description ?? '',
      amount: v.amount,
    })),
  }
}

/**
 * Proposals keyed by transaction id for the open rows of one bank account.
 * Rows the detector cannot explain are simply absent. Advisory: a detector
 * failure logs and returns nothing rather than taking the bridge table down;
 * the row stays unmatched and the booking doors keep their own guard.
 */
export async function proposeCoveringSets(
  supabase: SupabaseClient,
  companyId: string,
  account: { ledger_account: string; currency: string | null },
  rows: CoveringSetRow[],
): Promise<Map<string, ReconciliationProposal>> {
  const proposals = new Map<string, ReconciliationProposal>()
  if (rows.length === 0 || (account.currency ?? 'SEK') !== 'SEK') return proposals
  try {
    const sets = await detectExplainingVoucherSets(supabase, {
      companyId,
      bankAccountNumber: account.ledger_account,
      transactions: rows.map((r) => ({ id: r.id, date: r.date, amount: r.amount, currency: r.currency })),
    })
    for (const [transactionId, set] of sets) {
      proposals.set(transactionId, coveringSetProposal(set))
    }
  } catch (err) {
    log.warn('covering-set proposals skipped', {
      companyId,
      entityType: 'cash_account',
      details: {
        account: account.ledger_account,
        message: err instanceof Error ? err.message : String(err),
      },
    })
  }
  return proposals
}
