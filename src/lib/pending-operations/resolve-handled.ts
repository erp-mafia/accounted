/**
 * A proposal whose bank row got booked another way is closed, not left to fail.
 *
 * A staged categorize_transaction, bulk_book_transactions or
 * ignore_transaction waits for an approval. Meanwhile the person books the
 * same row by hand, accepts the system's own suggestion for it, or matches it
 * to an invoice. The proposal then stays in the queue, approvable but dead:
 * the commit refuses a booked row (TRANSACTION_ALREADY_CATEGORIZED,
 * BULK_BOOK_TX_ALREADY_BOOKED, TX_IGNORE_ALREADY_BOOKED), so the approval
 * answers "Misslyckades", and until then the person has to reject it by hand.
 * "Redan gjort manuellt" was the most common reason people typed on a
 * rejection.
 *
 * This reads the pending operations a list is about to show and closes the
 * ones the database says can never commit: a row they would book or ignore
 * is booked already (transactions.is_booked, the one answer every booking
 * door uses). They are rejected as 'superseded', the system's word for
 * "handled another way": nobody judged the proposal, and nothing was booked
 * by it.
 *
 * Only a booked row counts. A possible duplicate (same day, same amount on
 * another row) is a person's call and is never closed here. A row
 * that is missing, ignored or unreadable leaves its proposal alone too.
 *
 * Runs where the queue is read, not where rows are booked: there are many
 * booking doors and one queue, and a proposal nobody looks at harms nobody
 * (the 30-day expiry still closes it).
 *
 * Never throws: a list that cannot tidy itself still lists.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'
import type { PendingOperation } from '@/types'
import { HANDLED_ELSEWHERE_REASON } from './handled-elsewhere'
import { claimedTransactionIds } from './transaction-claims'

const log = createLogger('pending-operations/resolve-handled')

/** Bank rows read per request (PostgREST's URL carries the id list). */
const READ_CHUNK = 200

type Candidate = Pick<PendingOperation, 'id' | 'operation_type' | 'params' | 'status' | 'risk_level'>

/** The bank rows an open proposal needs unbooked in order to commit. */
function rowsItNeedsUnbooked(operation: Candidate): string[] {
  if (operation.operation_type === 'ignore_transaction') {
    const id = operation.params?.transaction_id
    return typeof id === 'string' && id.length > 0 ? [id] : []
  }
  return claimedTransactionIds(operation.operation_type, operation.params)
}

/**
 * Close the pending operations among `operations` whose bank row is already
 * booked. Returns the ids actually closed (compare-and-set on 'pending': one
 * approved or rejected meanwhile is left as it is).
 */
export async function resolveHandledProposals(
  supabase: SupabaseClient,
  companyId: string,
  operations: Candidate[],
): Promise<string[]> {
  try {
    const needs = new Map<string, string[]>()
    for (const operation of operations) {
      if (operation.status !== 'pending') continue
      const rows = rowsItNeedsUnbooked(operation)
      if (rows.length > 0) needs.set(operation.id, rows)
    }
    if (needs.size === 0) return []

    const rowIds = [...new Set([...needs.values()].flat())]
    const booked = new Set<string>()
    for (let start = 0; start < rowIds.length; start += READ_CHUNK) {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, is_booked')
        .eq('company_id', companyId)
        .in('id', rowIds.slice(start, start + READ_CHUNK))
      // An unreadable row decides nothing: its proposal stays.
      if (error) throw new Error(error.message)
      for (const row of (data ?? []) as Array<{ id: string; is_booked: boolean | null }>) {
        if (row.is_booked === true) booked.add(row.id)
      }
    }

    const handled = [...needs.entries()]
      .filter(([, rows]) => rows.some((row) => booked.has(row)))
      .map(([id]) => id)
    if (handled.length === 0) return []

    const { data: closed, error: closeError } = await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        rejection_category: 'superseded',
        result_data: { auto_rejected: true, reason: HANDLED_ELSEWHERE_REASON },
      })
      .in('id', handled)
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .select('id')
    if (closeError) throw new Error(closeError.message)
    const closedIds = ((closed ?? []) as Array<{ id: string }>).map((row) => row.id)

    const byId = new Map(operations.map((operation) => [operation.id, operation]))
    await Promise.all(
      closedIds.map(async (id) => {
        const operation = byId.get(id)
        if (!operation) return
        try {
          await appendProcessingHistory({
            companyId,
            correlationId: id,
            aggregateType: 'System',
            aggregateId: id,
            eventType: 'PendingOperationRejected',
            payload: {
              operation_id: id,
              operation_type: operation.operation_type,
              risk_level: operation.risk_level,
              channel: 'system',
              has_reason: false,
              reason: HANDLED_ELSEWHERE_REASON,
            },
            actor: { type: 'system', id: 'pending-operations/resolve-handled' },
            occurredAt: new Date(),
          })
        } catch (err) {
          log.warn('Failed to append PendingOperationRejected audit event', {
            operationId: id,
            error: err instanceof Error ? err.message : 'unknown',
          })
        }
      }),
    )
    if (closedIds.length > 0) log.info('closed proposals whose bank row is already booked', { companyId, count: closedIds.length })
    return closedIds
  } catch (err) {
    log.warn('handled proposals not closed', { companyId, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
