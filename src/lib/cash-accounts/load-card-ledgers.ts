import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'

const log = createLogger('cash-accounts/card-ledgers')

/**
 * The ledgers of the company's cards (cash_accounts kind 'card'): the money
 * ledgers settleBankLeg moves a bank leg off besides 19xx (bank-leg.ts).
 *
 * Read only when a proposal's bank leg sits on a card-shaped ledger that is
 * not the row's own (needsCardLedgers), so an ordinary booking pays nothing.
 * A failed read answers [] and logs: the proposal then books as before this
 * existed, and the commit guard still refuses a wrong bank leg.
 */
export async function loadCardLedgers(supabase: SupabaseClient, companyId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account')
    .eq('company_id', companyId)
    .eq('kind', 'card')
  if (error) {
    log.warn('card ledger lookup failed; settling without them', { companyId, error: error.message })
    return []
  }
  return ((data ?? []) as { ledger_account: string | null }[])
    .map((row) => row.ledger_account)
    .filter(isCardLedgerAccount)
}

/**
 * Whether settling this pair on the row's ledger needs the company's card
 * ledgers: its bank leg is card-shaped and not already the row's own ledger.
 */
export function needsCardLedgers(
  pair: { debit_account: string; credit_account: string },
  transactionAmount: number,
  settlementAccount: string,
): boolean {
  const bankLeg = transactionAmount < 0 ? pair.credit_account : pair.debit_account
  return isCardLedgerAccount(bankLeg) && bankLeg !== settlementAccount
}

/** One of the company's cards, addressed by its ledger; null when no card books there. */
export async function findCardCashAccount(
  supabase: SupabaseClient,
  companyId: string,
  ledgerAccount: string,
): Promise<{ id: string; currency: string; enabled: boolean; name: string | null } | null> {
  if (!isCardLedgerAccount(ledgerAccount)) return null
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, currency, enabled, name')
    .eq('company_id', companyId)
    .eq('kind', 'card')
    .eq('ledger_account', ledgerAccount)
    .maybeSingle()
  if (error) throw new Error(`card cash account lookup failed: ${error.message}`)
  return (data as { id: string; currency: string; enabled: boolean; name: string | null } | null) ?? null
}
