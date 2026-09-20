import type { SupabaseClient } from '@supabase/supabase-js'
import type { CashAccount } from '@/types'
import { setPrimary } from '@/lib/cash-accounts/service'
import { isBankCashAccount } from '@/lib/cash-accounts/invoice-payee'

/**
 * Why an account cannot be made the company's primary by hand, in the order
 * the checks run. 'not_found' covers another company's id as well.
 */
export type PrimaryIneligibleReason = 'not_found' | 'disabled' | 'not_sek' | 'not_bank_account'

export type MakePrimaryResult =
  | { ok: true; account: CashAccount }
  | { ok: false; reason: PrimaryIneligibleReason }

/**
 * The one definition of "may be the primary account", shared by the server
 * (makePrimary) and the settings row that offers the action, so the UI never
 * shows a button the server refuses.
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
): Exclude<PrimaryIneligibleReason, 'not_found'> | null {
  if (!account.enabled) return 'disabled'
  if ((account.currency ?? '').toUpperCase() !== 'SEK') return 'not_sek'
  if (!isBankCashAccount(account)) return 'not_bank_account'
  return null
}

/**
 * Make one of the company's cash accounts its primary. The swap itself is the
 * set_cash_account_primary RPC (one transaction, never a moment without a
 * primary); this adds the eligibility rule the RPC does not have.
 *
 * Writes cash_accounts.is_primary on two rows and nothing else. No journal
 * entry, line or transaction is touched: everything that reads the primary
 * resolves it at the moment it books or lists, so only later bookings follow.
 */
export async function makePrimary(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<MakePrimaryResult> {
  const read = () =>
    supabase
      .from('cash_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('id', cashAccountId)
      .maybeSingle()

  const before = await read()
  if (before.error) throw new Error(`cash_accounts makePrimary lookup failed: ${before.error.message}`)
  if (!before.data) return { ok: false, reason: 'not_found' }
  const account = before.data as CashAccount

  const reason = primaryIneligibleReason(account)
  if (reason) return { ok: false, reason }
  if (account.is_primary) return { ok: true, account }

  // Who is primary now, so a swap that turns out to be wrong can be undone.
  const previous = await supabase
    .from('cash_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .neq('id', cashAccountId)
    .maybeSingle()
  if (previous.error) throw new Error(`cash_accounts makePrimary lookup failed: ${previous.error.message}`)
  const previousId = (previous.data as { id: string } | null)?.id ?? null

  await setPrimary(supabase, companyId, cashAccountId)

  const after = await read()
  if (after.error) throw new Error(`cash_accounts makePrimary re-read failed: ${after.error.message}`)
  if (!after.data) return { ok: false, reason: 'not_found' }

  // The RPC checks only that the row exists, so the eligibility read above and
  // the swap are two statements: a disable that commits in between would leave
  // a disabled primary. This re-read catches every such case, because once the
  // swap has committed setEnabled()'s own predicate (is_primary = false)
  // refuses any further disable of this row. Hand the flag back and refuse.
  const lateReason = primaryIneligibleReason(after.data as CashAccount)
  if (lateReason) {
    if (previousId) await setPrimary(supabase, companyId, previousId)
    return { ok: false, reason: lateReason }
  }
  return { ok: true, account: after.data as CashAccount }
}
