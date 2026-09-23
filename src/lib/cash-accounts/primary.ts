import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount } from '@/types'
import { isBankCashAccount } from '@/lib/cash-accounts/invoice-payee'

/**
 * Why an account cannot be made the company's primary by hand, in the order
 * the checks run. 'not_found' covers another company's id as well;
 * 'forbidden' is the database's own owner/admin check.
 */
export type PrimaryIneligibleReason =
  | 'not_found'
  | 'forbidden'
  | 'disabled'
  | 'not_sek'
  | 'not_bank_account'

export type MakePrimaryResult =
  | { ok: true; account: CashAccount }
  | { ok: false; reason: PrimaryIneligibleReason }

/**
 * The UI-side mirror of the rule make_cash_account_primary enforces
 * (migration 20260921070500), so the settings row never offers a button the
 * database refuses. The database is the authority; this only decides what to
 * show. tests/pg/cash-accounts-routing-audit.pg.test.ts runs the same cases
 * through both and fails if they drift.
 *
 * The primary is where bookings land when nothing else says which bank account
 * they belong to: the skattekonto __PRIMARY_SEK__ counter leg and the owner of
 * transactions with no cash_account_id. So it must be an enabled SEK giro or
 * bank account (BAS 1920-1999): not a hidden row, not a currency account the
 * SEK sentinel would fall back onto, not a PSP clearing account or a till.
 * An account a bank connection holds qualifies: the PSD2 sync never picks a
 * primary, it only carries the flag along when it merges a duplicate row.
 */
export function primaryIneligibleReason(
  account: Pick<CashAccount, 'enabled' | 'currency' | 'ledger_account'>,
): Exclude<PrimaryIneligibleReason, 'not_found' | 'forbidden'> | null {
  if (!account.enabled) return 'disabled'
  if ((account.currency ?? '').toUpperCase() !== 'SEK') return 'not_sek'
  if (!isBankCashAccount(account)) return 'not_bank_account'
  return null
}

/** The refusal the RPC raised, read off its message; null for any other error. */
function refusalFromRpcError(message: string): PrimaryIneligibleReason | null {
  if (message.includes('CASH_ACCOUNT_NOT_FOUND')) return 'not_found'
  if (message.includes('CASH_ACCOUNT_PRIMARY_ADMIN_ONLY')) return 'forbidden'
  const match = /CASH_ACCOUNT_PRIMARY_INELIGIBLE: (disabled|not_sek|not_bank_account)/.exec(message)
  return match ? (match[1] as PrimaryIneligibleReason) : null
}

/**
 * Make one of the company's cash accounts its primary, through the
 * make_cash_account_primary RPC: it locks the row, checks eligibility and
 * swaps the flag in one transaction, so a concurrent disable either lands
 * first and is refused here, or waits and no longer matches its own predicate.
 *
 * Not set_cash_account_primary: that one carries the flag for system merges
 * (PSD2 sync, twin heal) and deliberately has no eligibility rule.
 *
 * Writes cash_accounts.is_primary on two rows and nothing else. No journal
 * entry, line or transaction is touched: everything that reads the primary
 * resolves it at the moment it books or lists, so only later bookings follow.
 * The change itself is logged to audit_log by the audit_cash_accounts_routing
 * trigger, with the acting user.
 */
export async function makePrimary(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<MakePrimaryResult> {
  const { data, error } = await supabase.rpc('make_cash_account_primary', {
    p_company_id: companyId,
    p_cash_account_id: cashAccountId,
  })
  if (error) {
    const reason = refusalFromRpcError(error.message ?? '')
    if (reason) return { ok: false, reason }
    throw new Error(`cash_accounts makePrimary failed: ${error.message}`)
  }
  // A composite-returning function comes back as the row (or a one-row array,
  // depending on how PostgREST was asked).
  const account = (Array.isArray(data) ? data[0] : data) as CashAccount | null
  if (!account) return { ok: false, reason: 'not_found' }
  return { ok: true, account }
}
