/**
 * A storno of an expense claim's verifikat (source_type expense_claim),
 * refused while the claim stands.
 *
 * reverseEntry() (lib/bookkeeping/engine.ts) runs the check through the
 * reversal hook list (lib/composition/reversal-hooks.ts) before anything is
 * written. A storno of the verifikat alone would leave the claim in the
 * register against a cost and a debt the ledger no longer holds: an unpaid
 * claim would still be offered for a payout, and a paid one's payout would
 * clear a debt that is gone.
 *
 * What the refusal names follows what Ta bort (deleteExpenseClaim,
 * expense-claims-service.ts) answers for the claim, so it never names a step
 * that refuses:
 *   - registered, on no payslip or on a draft run's: Ta bort, which reverses
 *     the verifikat and removes the claim together. Its own storno passes the
 *     reverseEntry option expenseClaimRemoval and is let through by the hook
 *     list.
 *   - paid out, or on the payslip of a run past draft (repaid with the
 *     salary): Ta bort refuses both, and no step undoes a payout, so the
 *     verifikat is corrected instead (Rätta); a correction moves the claim's
 *     pointer to the corrected verifikat (correction-payment-relink.ts).
 *
 * The claim is the one whose journal_entry_id names the verifikat. A
 * verifikat no claim points at passes (a removed claim's is reversed already).
 *
 * Kept free of engine imports so the engine can reach it through the
 * composition seam without a cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { PaidExpenseClaimStornoError, RegisteredExpenseClaimStornoError } from '@/lib/bookkeeping/errors'
import { readPayslipLinesForClaims } from '@/lib/salary/expense-claim-payout-state'

/**
 * Throws RegisteredExpenseClaimStornoError when the claim the verifikat books
 * can be removed with Ta bort, and PaidExpenseClaimStornoError when it is paid
 * out or repaid with the salary.
 */
export async function assertExpenseClaimVerifikatReversible(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('expense_claims')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('journal_entry_id', journalEntryId)
  if (error) throw new Error(`expense claim verifikat: lookup by voucher failed: ${error.message}`)
  const claim = ((data ?? []) as Array<{ id: string; status: string }>)[0]
  if (!claim) return
  if (claim.status === 'paid') throw new PaidExpenseClaimStornoError(claim.id)

  // On the payslip of a run past draft the salary repays the claim, and Ta
  // bort refuses it (ON_PAYSLIP); on a draft run's, Ta bort takes the line off.
  const line = (await readPayslipLinesForClaims(supabase, companyId, [claim.id])).get(claim.id)
  const run = line?.salary_run
  if (run && run.status !== 'draft') throw new PaidExpenseClaimStornoError(claim.id)
  throw new RegisteredExpenseClaimStornoError(claim.id)
}
