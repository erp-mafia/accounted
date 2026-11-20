/**
 * The company's accounts as a bank payment sees them: whether a payment can
 * leave from each (debtor.ts resolveDebtor) and in which account context it
 * would be made (debtor.ts paymentAccountContext), which decides whether the
 * company's verification stands in the way (readiness.ts).
 *
 * No provider registry here: the worklist reads it too.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { paymentAccountContext, resolveDebtor, type DebtorResolution } from './debtor'
import type { PaymentAccountContext } from './readiness'

export interface PayableAccount {
  id: string
  name: string | null
  ledger_account: string
  iban: string | null
  /** The bank behind the account, as its connection reports it; the mark and the signing step name it. */
  bank_name: string | null
  payable: boolean
  reason: Exclude<DebtorResolution, { ok: true }>['reason'] | null
  /** private for an account connected as the owner's personal agreement, else corporate. */
  account_context: PaymentAccountContext
  /**
   * The company's primary bank account (cash_accounts.is_primary): the one a
   * skattekonto inbetalning is booked against and the Skatteverket payment
   * file pays from, so the skattekonto payment dialog opens on it.
   */
  is_primary: boolean
}

export async function readPaymentAccounts(client: SupabaseClient, companyId: string): Promise<PayableAccount[]> {
  const { data, error } = await client
    .from('cash_accounts')
    .select('id, name, ledger_account, iban, currency, enabled, is_primary, bank_connection:bank_connections(bank_name, bic, affiliated_aspsp_id, psu_type)')
    .eq('company_id', companyId)
    // A payment file is paid from a bank account; a company card never pays
    // one (it carries no IBAN either, so this is defense in depth).
    .eq('kind', 'bank')
    .order('ledger_account', { ascending: true })
  if (error) throw error
  return ((data ?? []) as unknown as Array<{
    id: string
    name: string | null
    ledger_account: string
    iban: string | null
    currency: string
    enabled: boolean
    is_primary: boolean | null
    bank_connection: { bank_name: string | null; bic: string | null; affiliated_aspsp_id: string | null; psu_type: string | null } | null
  }>).map((a) => {
    const debtor = resolveDebtor(a, a.bank_connection)
    return {
      id: a.id,
      name: a.name,
      ledger_account: a.ledger_account,
      iban: a.iban,
      bank_name: a.bank_connection?.bank_name ?? null,
      payable: debtor.ok,
      reason: debtor.ok ? null : debtor.reason,
      account_context: paymentAccountContext(a.bank_connection?.psu_type),
      is_primary: a.is_primary === true,
    }
  })
}
