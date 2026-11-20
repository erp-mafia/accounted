/**
 * Live bank accounts, the one usage kind counted as a state rather than as
 * events (USAGE_GAUGE_KINDS): the accounts switched on in the company's
 * active bank connections, read from the connection rows the bank sync
 * already keeps.
 *
 * An account counts once however many connections carry it (a reconnect
 * leaves two active rows for a moment, and the bank gives the same account a
 * new uid each consent), so the key is its IBAN, else its BBAN, else its uid.
 * An account another company has claimed is that company's, and a card
 * account that only mirrors the main account is never switched on.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/** The account fields the count reads from bank_connections.accounts_data. */
export interface CountedBankAccount {
  uid: string
  iban?: string | null
  bban?: string | null
  enabled?: boolean | null
  claimed_by_company_id?: string | null
  mirror_card_account?: boolean | null
}

function accountKey(account: CountedBankAccount): string {
  return (account.iban || account.bban || account.uid).replace(/\s+/g, '').toUpperCase()
}

/** The keys of the accounts in `accounts` that are live for `companyId`. */
export function liveAccountKeys(accounts: unknown, companyId: string): Set<string> {
  const keys = new Set<string>()
  if (!Array.isArray(accounts)) return keys
  for (const account of accounts as CountedBankAccount[]) {
    if (!account || typeof account.uid !== 'string') continue
    if (account.enabled !== true || account.mirror_card_account === true) continue
    if (account.claimed_by_company_id && account.claimed_by_company_id !== companyId) continue
    keys.add(accountKey(account))
  }
  return keys
}

/**
 * The company's live accounts, by key: every active, not superseded
 * connection, except `exceptConnectionId` (a selection about to replace that
 * connection's accounts). Throws on a failed read.
 */
export async function readLiveBankAccounts(
  db: SupabaseClient,
  companyId: string,
  options: { exceptConnectionId?: string } = {},
): Promise<Set<string>> {
  const { data, error } = await db
    .from('bank_connections')
    .select('id, accounts_data')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .is('superseded_at', null)
  if (error) throw new Error(`bank_connections read failed: ${error.message}`)
  const keys = new Set<string>()
  for (const row of (data ?? []) as Array<{ id: string; accounts_data: unknown }>) {
    if (row.id === options.exceptConnectionId) continue
    for (const key of liveAccountKeys(row.accounts_data, companyId)) keys.add(key)
  }
  return keys
}

/** Every company's live accounts right now, for the monthly statements. Companies with none are absent. */
export async function countLiveBankAccountsByCompany(service: SupabaseClient): Promise<Map<string, number>> {
  const rows = await fetchAllRows<{ id: string; company_id: string | null; accounts_data: unknown }>(({ from, to }) =>
    service
      .from('bank_connections')
      .select('id, company_id, accounts_data')
      .eq('status', 'active')
      .is('superseded_at', null)
      .order('id')
      .range(from, to),
  )
  const byCompany = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.company_id) continue
    const keys = byCompany.get(row.company_id) ?? new Set<string>()
    for (const key of liveAccountKeys(row.accounts_data, row.company_id)) keys.add(key)
    byCompany.set(row.company_id, keys)
  }
  const counts = new Map<string, number>()
  for (const [companyId, keys] of byCompany) if (keys.size > 0) counts.set(companyId, keys.size)
  return counts
}
