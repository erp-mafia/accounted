import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankIngestRoute } from '@/types'
import { dbError } from '@/lib/errors/db-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'

/** A changed route must be reloaded without marking the bank consent broken. */
export function isBankRoutingConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'PT409'
}

/**
 * The one routing conflict a retry never fixes: an enabled account has no
 * bound cash account, or its stored ledger differs from the bound one. The
 * consent is fine (the row stays active), but the user must save the account
 * picker again, so the sync paths store BANK_ROUTE_NEEDS_CONFIGURATION_MESSAGE
 * instead of staying silent.
 */
export function isBankRouteUnresolved(error: unknown): boolean {
  return isBankRoutingConflict(error)
    && (error as { message?: unknown }).message === 'BANK_INGEST_ROUTE_UNRESOLVED'
}

/** Stored as bank_connections.error_message; cleared by the next successful sync. */
export const BANK_ROUTE_NEEDS_CONFIGURATION_MESSAGE: string =
  getErrorEntry('BANK_INGEST_ROUTE_UNRESOLVED')!.message_sv

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
  // A PT409 refusal keeps the raised name as its message: that name is what
  // conflictCode() and isBankRouteUnresolved() dispatch on.
  if (error) throw dbError(error, (error as { code?: unknown }).code === 'PT409' ? null : 'Bank ingest route')
  const route = data as BankIngestRoute | null
  if (!route?.token || !route.cashAccountId || !route.ledgerAccount || !route.sessionId
      || route.accountUid !== accountUid || route.connectionId !== connectionId
      || route.currency !== currency.toUpperCase()) {
    throw new Error('Bank ingest route could not be resolved')
  }
  return route
}
