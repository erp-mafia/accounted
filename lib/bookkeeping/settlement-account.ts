import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

const FALLBACK_ACCOUNT = '1930'

/**
 * Resolve the BAS ledger account a transaction actually settles from/to.
 *
 * Never fall back to a company-wide "last used" setting (e.g.
 * last_supplier_payment_account, written by the manual mark-paid
 * private-funds flow): those reflect unrelated flows with no relationship
 * to which bank account a specific transaction is linked to.
 * cash_account_id -> cash_accounts.ledger_account is the only source of
 * truth for a real transaction's settlement account.
 */
export async function resolveSettlementAccount(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string | null,
  log: Logger,
): Promise<string> {
  if (!cashAccountId) return FALLBACK_ACCOUNT

  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account')
    .eq('id', cashAccountId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    log.warn('settlement-account lookup failed; defaulting to 1930', {
      cashAccountId,
      error: error.message,
    })
  }

  return (data?.ledger_account as string) || FALLBACK_ACCOUNT
}
