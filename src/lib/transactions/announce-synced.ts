import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { chunk } from '@/lib/utils'
import type { Transaction } from '@/types'

/**
 * Ids per read of the inserted rows. One .in() over a first import's ids puts
 * every id in the PostgREST URL: in production reads of about 700 ids and
 * more failed, so the event never fired. Enable Banking reads 200 at a time.
 */
export const SYNCED_ROWS_READ_CHUNK = 200

/**
 * One transaction.synced for the rows an ingest inserted, read back by their
 * ids in chunks. Best effort: the rows are stored, so a failed read is logged
 * as an error (the event's handlers never see these rows, and nothing asks
 * again) and the event skipped, never thrown at the caller. Answers how many
 * rows were announced.
 */
export async function announceSyncedTransactions(
  supabase: SupabaseClient,
  input: {
    companyId: string
    userId: string
    transactionIds: readonly string[]
    log: { error: (message: string, meta?: Record<string, unknown>) => void }
    /** Ids for the failure log line (connection, import). */
    context?: Record<string, unknown>
  },
): Promise<number> {
  const { companyId, userId, transactionIds, log, context } = input
  if (transactionIds.length === 0) return 0
  const transactions: Transaction[] = []
  for (const ids of chunk(transactionIds, SYNCED_ROWS_READ_CHUNK)) {
    const { data, error } = await supabase.from('transactions').select('*').eq('company_id', companyId).in('id', ids)
    if (error) {
      log.error('synced rows not announced: the read failed', { ...context, companyId, rows: transactionIds.length, message: error.message })
      return 0
    }
    transactions.push(...((data ?? []) as Transaction[]))
  }
  if (transactions.length === 0) return 0
  await eventBus.emit({ type: 'transaction.synced', payload: { transactions, userId, companyId } })
  return transactions.length
}
