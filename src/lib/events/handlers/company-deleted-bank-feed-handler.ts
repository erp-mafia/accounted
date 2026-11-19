import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { OPEN_PAYMENTS_AGGREGATOR } from '@/lib/bank-sync/aggregator'
import { disconnectBankFeedConnection } from '@/lib/bank-feed/service'
import { createLogger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'

const log = createLogger('company-deleted-bank-feed')

/**
 * A deleted company's Open Payments connections end with it. Once the
 * company is archived nobody can open Kopplingar to disconnect them, yet each
 * consent stays live at the bank, and
 * the sync would keep reading a company its members were told is gone.
 *
 * Every row that may still hold a consent (any status but 'revoked') goes
 * through the same disconnect a person makes (disconnectBankFeedConnection):
 * the local disconnect, the consent ended at the bank, and a consent the
 * bank did not end named on the row for the daily retry
 * (lib/bank-feed/unended-consents.ts). The actor is the owner who deleted
 * the company; members are kept on an archived company, so the disconnect
 * RPC's membership check holds. On the service client: RLS hides an
 * archived company from every session.
 *
 * One at a time: each disconnect checks the company's bank configuration
 * token, which the one before it changes. Best effort and never thrown: the
 * deletion has already happened, and a connection that fails twice is
 * logged without stopping the next. Enable Banking rows are not touched here.
 */
export async function endBankFeedsOfDeletedCompany({ companyId, userId }: EventPayload<'company.deleted'>): Promise<void> {
  const supabase = createServiceClientNoCookies()

  // Only an archived company: ending a consent makes its owner sign again
  // with BankID, so a stray event never reaches a live company's bank.
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('archived_at')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) {
    log.error('deleted company not read; its bank connections were left as they are', { companyId, message: companyError.message })
    return
  }
  if (!company?.archived_at) {
    log.warn('company.deleted for a company that is not archived; its bank connections were left as they are', { companyId })
    return
  }

  const { data: connections, error } = await supabase
    .from('bank_connections')
    .select('id')
    .eq('company_id', companyId)
    .eq('aggregator', OPEN_PAYMENTS_AGGREGATOR)
    .neq('status', 'revoked')
  if (error) {
    log.error('bank connections of the deleted company not read; none was disconnected', { companyId, message: error.message })
    return
  }

  const ctx: OperationContext = { supabase, companyId, userId, log }
  for (const { id: connectionId } of (connections ?? []) as Array<{ id: string }>) {
    // Once more after a failure: a sync that writes the connection between the
    // disconnect's configuration read and its RPC is refused as
    // BANK_CONFIGURATION_CHANGED, and nothing else reaches this row once the
    // company is hidden (the daily retry reads only removed rows).
    let failure = await disconnectOnce(ctx, connectionId)
    if (failure) failure = await disconnectOnce(ctx, connectionId)
    if (failure) log.error('bank connection of the deleted company not disconnected', { companyId, connectionId, failure })
    else log.info('bank connection of the deleted company disconnected', { companyId, connectionId })
  }
}

/** Null when the connection is disconnected (or already gone), else why not. */
async function disconnectOnce(ctx: OperationContext, connectionId: string): Promise<string | null> {
  try {
    const outcome = await disconnectBankFeedConnection(ctx, connectionId)
    return outcome.ok || outcome.code === 'NOT_FOUND' ? null : outcome.code
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
