import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankIngestRoute } from '@/types'
import { dbError } from '@/lib/errors/db-error'

/** A changed route must be reloaded without marking the bank consent broken. */
export function isBankRoutingConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'PT409'
}

/** Resolve before the provider fetch; inserts validate the same token under locks. */
export async function resolveBankIngestRoute(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
  accountUid: string,
  currency: string,
): Promise<BankIngestRoute> {
  const { data, error } = await supabase.rpc('resolve_bank_ingest_route', {
    p_company_id: companyId, p_connection_id: connectionId,
    p_account_uid: accountUid, p_currency: currency,
  })
  if (error) throw dbError(error, 'Bank ingest route')
  const route = data as BankIngestRoute | null
  if (!route?.token || !route.cashAccountId || !route.ledgerAccount || !route.sessionId
      || route.accountUid !== accountUid || route.connectionId !== connectionId
      || route.currency !== currency.toUpperCase()) {
    throw new Error('Bank ingest route could not be resolved')
  }
  return route
}
