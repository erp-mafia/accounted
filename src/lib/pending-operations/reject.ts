/**
 * Reject pending operations: the one write behind every "no" to a staged
 * proposal (the dashboard's single and bulk reject, the MCP reject tool and
 * the v1 REST reject endpoint).
 *
 * Each door parses its own input (the app requires a category, MCP lets an
 * agent relay a bare no without inventing one) and maps the per-id outcome
 * to its own response; the write itself is here, so every door records the
 * same facts: status, category and reason when given, who rejected and
 * through what (result_data, since pending_operations has no resolved_by
 * column), and one PendingOperationRejected audit row per rejected
 * operation, mirroring the approval path.
 *
 * The UPDATE is a compare-and-set on status 'pending': commit claims rows
 * atomically (pending -> committing), so a reject that loses that race must
 * not stamp 'rejected' over an operation that has since posted a verifikat.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { createLogger } from '@/lib/logger'
import type { PersonRejectionCategory } from './rejection-categories'

const log = createLogger('pending-operations/reject')

/** Who decided, as the door knows it. */
export interface RejectActor {
  /** The authenticated user the rejection is recorded under. */
  userId: string
  /** 'user' for a person in the app; the key's actor type otherwise (api_key, service_account, ...). */
  type: string
  /** The API key or OAuth client id, when the decision came through one. */
  id?: string
  label?: string
}

export interface RejectPendingOperationsInput {
  companyId: string
  ids: string[]
  /** A person's verdict, or 'superseded' when the assistant withdraws a proposal. */
  category?: PersonRejectionCategory | 'superseded'
  /** Trimmed free text; the door enforces its own length. */
  reason?: string
  actor: RejectActor
  /** The door: the dashboard, the MCP tool, or the v1 REST endpoint. */
  channel: 'app' | 'mcp' | 'api'
}

export type RejectOutcome =
  | { id: string; outcome: 'rejected' }
  | { id: string; outcome: 'not_found' }
  | { id: string; outcome: 'not_pending'; status: string }
  | { id: string; outcome: 'lost_race' }

export type RejectPendingOperationsResult =
  | { ok: true; outcomes: RejectOutcome[] }
  | { ok: false; stage: 'fetch' | 'update'; error: { message: string; code?: string } }

interface OperationRow {
  id: string
  status: string
  operation_type: string
  risk_level: string
}

export async function rejectPendingOperations(
  supabase: SupabaseClient,
  input: RejectPendingOperationsInput,
): Promise<RejectPendingOperationsResult> {
  const { companyId, ids, category, actor, channel } = input
  const reason = input.reason?.trim() || undefined

  // A malformed id fails this read with 22P02 (code kept, so a door can
  // answer it as not found).
  const { data: rows, error: fetchError } = await supabase
    .from('pending_operations')
    .select('id, status, operation_type, risk_level')
    .in('id', ids)
    .eq('company_id', companyId)
  if (fetchError) {
    return { ok: false, stage: 'fetch', error: { message: fetchError.message, code: fetchError.code } }
  }

  const byId = new Map(((rows ?? []) as OperationRow[]).map((row) => [row.id, row]))
  const pendingIds = ids.filter((id) => byId.get(id)?.status === 'pending')

  let rejectedIds = new Set<string>()
  if (pendingIds.length > 0) {
    const { data: updated, error: updateError } = await supabase
      .from('pending_operations')
      .update({
        status: 'rejected',
        resolved_at: new Date().toISOString(),
        ...(category ? { rejection_category: category } : {}),
        ...(reason ? { rejection_reason: reason } : {}),
        result_data: {
          rejected_by: actor.userId,
          rejected_via: actor.type,
          ...(actor.id ? { actor_id: actor.id } : {}),
          ...(reason ? { reason } : {}),
        },
      })
      .in('id', pendingIds)
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .select('id')
    if (updateError) {
      return { ok: false, stage: 'update', error: { message: updateError.message, code: updateError.code } }
    }
    rejectedIds = new Set(((updated ?? []) as Array<{ id: string }>).map((row) => row.id))
  }

  // Best effort: the rejection stands even when the history write fails.
  await Promise.all(
    [...rejectedIds].map(async (id) => {
      const row = byId.get(id)!
      try {
        await appendProcessingHistory({
          companyId,
          correlationId: id,
          aggregateType: 'System',
          aggregateId: id,
          eventType: 'PendingOperationRejected',
          payload: {
            operation_id: id,
            operation_type: row.operation_type,
            risk_level: row.risk_level,
            channel,
            has_reason: reason !== undefined,
          },
          actor: {
            // A key records its own kind: a service account's key as
            // service_account (labelled with the account's name), a person's
            // key as api_key; everything else is a person.
            type: actor.type === 'api_key' || actor.type === 'service_account' ? actor.type : 'user',
            id: actor.id ?? actor.userId,
            ...(actor.label ? { label: actor.label } : {}),
          },
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

  const outcomes: RejectOutcome[] = ids.map((id) => {
    const row = byId.get(id)
    if (!row) return { id, outcome: 'not_found' }
    if (rejectedIds.has(id)) return { id, outcome: 'rejected' }
    if (row.status !== 'pending') return { id, outcome: 'not_pending', status: row.status }
    // Read as pending, not updated: resolved by another session in between.
    return { id, outcome: 'lost_race' }
  })
  return { ok: true, outcomes }
}
