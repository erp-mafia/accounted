import type { SupabaseClient } from '@supabase/supabase-js'
import { findOpeningBalanceFloor, sumAccountBalance } from './ledger-balance'

/**
 * The balance (debit minus credit) of one account at the end of `day`: its
 * latest ingående balans on or before the day plus everything booked from
 * that day on, or all history when the account never had an IB. The one read
 * for "what stands on this account on a day" outside the reports, which get
 * the same figure from the trial balance (bookedBalancesAt,
 * lib/reconciliation/bank-balance-check.ts). The two parts live in
 * ledger-balance.ts; a reader that needs its own window on top of the floor
 * (the bank and skattekonto reconciliations) composes them there.
 *
 * A sum over every posting counts each year an IB restates once more: the
 * owner loan register read a 50 000 kr loan as 100 000 after the first
 * year-end, and the onboarding summary read a skattekonto of 6 000 kr as
 * 13 000 after two imported years.
 *
 * Null when the lines cannot be read (never 0: 0 is a balance claim). Throws
 * when the IB cannot be read, as findOpeningBalanceFloor does: without the
 * floor there is no balance to state.
 */
export async function accountBalanceThrough(
  supabase: SupabaseClient,
  companyId: string,
  accountNumber: string,
  day: string,
): Promise<number | null> {
  const floor = await findOpeningBalanceFloor(supabase, companyId, accountNumber, day)
  return sumAccountBalance(supabase, companyId, accountNumber, {
    ...(floor ? { fromDate: floor.date } : {}),
    cutoffDate: day,
  })
}
