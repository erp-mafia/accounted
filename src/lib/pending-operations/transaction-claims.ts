/**
 * One bank row, one open proposal (crm#1264).
 *
 * A staged categorize_transaction or bulk_book_transactions claims the bank
 * rows it would book until it is approved, rejected or expires. Before this,
 * staging only deduplicated on a caller-supplied idempotency_key, so an agent
 * that staged the same rows again without one (it saw them still listed as
 * unbooked, since an open proposal books nothing) put a second approvable
 * card for the same bank row in the queue. Approving both never booked a row
 * twice: the commit refuses a booked row (the bulk_book_transactions RPC
 * under row locks, categorize-core's bookable check and compare-and-set), so
 * the second approval is auto-rejected. What it did was ask the approver to
 * choose between two cards for one affärshändelse, high risk each.
 *
 * Every staging door asks checkTransactionClaims before it inserts:
 *   - clear: no open operation names any of the rows; stage.
 *   - replay: the only open claim is an operation of the same type with
 *     exactly these params, still pending. It is answered as the staging, as
 *     an idempotency_key replay is, and nothing new is staged: a blind retry
 *     converges on the operation the first call created.
 *   - supersede: every open claim is a pending proposal by the same stager
 *     (same user, actor type and actor id) whose rows the new proposal all
 *     covers. The agent changed its mind: the new one is staged and the older
 *     ones are rejected as superseded (supersedeTransactionClaims), so the
 *     queue keeps one card per row without the person rejecting the old one
 *     first, which a staging-only key cannot do itself.
 *   - claimed: anything else. Another stager's proposal, an older proposal
 *     with rows the new one leaves out (superseding it would silently drop
 *     their proposal), or one being approved right now. Refused with
 *     TRANSACTION_ALREADY_STAGED naming the operations, which the person
 *     approves or rejects first.
 * force / allow_duplicate change none of this: they dismiss an already
 * BOOKED twin, and an open proposal is not booked.
 *
 * Open is 'pending' or 'committing'. A rejected operation (by a person, or
 * by the expiry sweep after 30 days) and a committed one no longer claim
 * anything: a committed one has booked the rows, which the staging dry run
 * already refuses on its own.
 *
 * Not a database constraint: two stagings of the same rows in the same
 * instant can both pass. The commit's booked-row refusal keeps that from
 * ever booking twice; this check keeps the queue honest for the sequential
 * case, which is the one agents produce.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hashRequest } from '@/lib/api/idempotency'
import { codedRefusal } from '@/lib/errors/refusal'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { PendingOperation } from '@/types'
import { rejectPendingOperations } from './reject'

const log = createLogger('pending-operations/transaction-claims')

export const TRANSACTION_ALREADY_STAGED = 'TRANSACTION_ALREADY_STAGED'

/** The operation types that book bank rows, and where their params name the rows. */
const CLAIMED_ROWS: Record<string, (params: Record<string, unknown>) => unknown> = {
  categorize_transaction: (params) => [params.transaction_id],
  bulk_book_transactions: (params) => params.tx_ids,
}

const CLAIMING_TYPES = Object.keys(CLAIMED_ROWS)

/** Still open: awaiting approval, or being approved right now. */
const OPEN_STATUSES = ['pending', 'committing']

/** The bank rows an operation of this type would book; empty for every other type. */
export function claimedTransactionIds(operationType: string, params: Record<string, unknown> | null | undefined): string[] {
  const read = CLAIMED_ROWS[operationType]
  if (!read || !params) return []
  const ids = read(params)
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

/**
 * Who stages, as pending_operations records it: the user the row carries,
 * the actor_type written (a service account's key as 'service_account') and
 * the actor_id (the API key or OAuth client; null for a person in the app).
 */
export interface Stager {
  userId: string
  actorType: string
  actorId: string | null
}

/** An open operation that already names some of the rows. */
export interface TransactionClaim {
  operation_id: string
  operation_type: string
  status: string
  created_at: string
  /** The rows both name. */
  transaction_ids: string[]
}

export type TransactionClaimCheck =
  | { kind: 'clear' }
  | { kind: 'replay'; operation: PendingOperation }
  | { kind: 'supersede'; operations: PendingOperation[] }
  | { kind: 'claimed'; claims: TransactionClaim[] }

function sameStager(operation: PendingOperation, stager: Stager): boolean {
  if (operation.user_id !== stager.userId) return false
  // A key is its id: an OAuth key's open proposals from before it staged as
  // mcp_oauth carry api_key, and are still its own.
  if (stager.actorId) return operation.actor_id === stager.actorId
  return operation.actor_type === stager.actorType && (operation.actor_id ?? null) === null
}

/**
 * What staging `params` as `operationType` by `stager` would meet in the
 * company's open operations. Reads nothing for a type that books no bank
 * row. A failed read throws (a transient error the caller may retry):
 * staging blind would bring the double card back.
 */
export async function checkTransactionClaims(
  supabase: SupabaseClient,
  companyId: string,
  operationType: string,
  params: Record<string, unknown>,
  stager: Stager,
): Promise<TransactionClaimCheck> {
  const wanted = new Set(claimedTransactionIds(operationType, params))
  if (wanted.size === 0) return { kind: 'clear' }

  const open = await fetchAllRows<PendingOperation>(({ from, to }) =>
    supabase
      .from('pending_operations')
      .select('*')
      .eq('company_id', companyId)
      .in('status', OPEN_STATUSES)
      .in('operation_type', CLAIMING_TYPES)
      .order('id', { ascending: true })
      .range(from, to),
  )

  const claiming: Array<{ operation: PendingOperation; rows: string[]; overlap: string[] }> = []
  for (const operation of open) {
    const rows = claimedTransactionIds(operation.operation_type, operation.params)
    const overlap = rows.filter((id) => wanted.has(id))
    if (overlap.length > 0) claiming.push({ operation, rows, overlap })
  }
  if (claiming.length === 0) return { kind: 'clear' }

  // The stored params went through JSON; so does the comparison.
  const only = claiming.length === 1 ? claiming[0]!.operation : null
  if (
    only &&
    only.status === 'pending' &&
    only.operation_type === operationType &&
    hashRequest(only.params) === hashRequest(JSON.parse(JSON.stringify(params)))
  ) {
    return { kind: 'replay', operation: only }
  }

  const supersedable = claiming.every(
    ({ operation, rows }) =>
      operation.status === 'pending' && sameStager(operation, stager) && rows.every((id) => wanted.has(id)),
  )
  if (supersedable) {
    return {
      kind: 'supersede',
      operations: claiming.map(({ operation }) => operation).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    }
  }

  return {
    kind: 'claimed',
    claims: claiming
      .map(({ operation, overlap }) => ({
        operation_id: operation.id,
        operation_type: operation.operation_type,
        status: operation.status,
        created_at: operation.created_at,
        transaction_ids: overlap,
      }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }
}

/**
 * Reject the older proposals a new one replaced, through the one reject
 * path (status, rejection_category 'superseded', the reason naming the new
 * operation, who did it, one PendingOperationRejected audit row each), CAS
 * on 'pending'. Returns the ids actually rejected: one approved in between
 * stays as it is, and the new operation then fails at approval on the
 * booked row. Never throws: the new operation is already staged, and an old
 * one left pending is the harmless state this check exists to tidy.
 */
export async function supersedeTransactionClaims(
  supabase: SupabaseClient,
  companyId: string,
  operations: PendingOperation[],
  replacement: { operationId: string; stager: Stager; actorLabel?: string | null; channel: 'mcp' | 'api' },
): Promise<string[]> {
  if (operations.length === 0) return []
  const ids = operations.map((operation) => operation.id)
  try {
    const result = await rejectPendingOperations(supabase, {
      companyId,
      ids,
      category: 'superseded',
      reason: `Ersatt av ett nyare förslag för samma banktransaktioner (${replacement.operationId}).`,
      actor: {
        userId: replacement.stager.userId,
        type: replacement.stager.actorType,
        ...(replacement.stager.actorId ? { id: replacement.stager.actorId } : {}),
        ...(replacement.actorLabel ? { label: replacement.actorLabel } : {}),
      },
      channel: replacement.channel,
    })
    if (!result.ok) {
      log.warn('superseded proposals not rejected', { companyId, ids, stage: result.stage, error: result.error.message })
      return []
    }
    const rejected = result.outcomes.filter((outcome) => outcome.outcome === 'rejected').map((outcome) => outcome.id)
    if (rejected.length < ids.length) {
      log.warn('some superseded proposals were resolved meanwhile', { companyId, ids, rejected })
    }
    return rejected
  } catch (err) {
    log.warn('superseded proposals not rejected', {
      companyId,
      ids,
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/** The refusal's details: the operations to approve or reject first. */
function claimDetails(claims: TransactionClaim[]): Record<string, unknown> {
  return { pending_operations: claims }
}

function claimSentence(claims: TransactionClaim[]): string {
  return claims
    .map(
      (claim) =>
        `pending_operation ${claim.operation_id} (${claim.operation_type}, ${claim.status}, staged ${claim.created_at}) ` +
        `already holds transaction ${claim.transaction_ids.join(', ')}`,
    )
    .join('; ')
}

/** TRANSACTION_ALREADY_STAGED as the MCP door throws it, the operations in details. */
export function transactionAlreadyStagedRefusal(claims: TransactionClaim[]): Error {
  const ids = claims.map((claim) => claim.operation_id)
  const message =
    `Not staged: ${claimSentence(claims)}. A bank row is in one proposal at a time, and force/allow_duplicate do not change that ` +
    '(they only override a twin that is already booked). Your own pending proposal is replaced automatically only when the new one ' +
    'covers all of its rows; this one is not (another stager, rows yours leaves out, or an approval running now). If that proposal is ' +
    'right, it is approved as it stands. If yours should replace it, have it rejected first, then stage again.'
  return Object.assign(
    codedRefusal(TRANSACTION_ALREADY_STAGED, message, {
      description:
        `Approve or reject ${ids.join(', ')} first: gnubok_approve_pending_operation / gnubok_reject_pending_operation when this key has ` +
        'the pending_operations:approve scope, otherwise the person does it in Accounted under Att göra (/pending). Stage again only after that.',
    }),
    { details: claimDetails(claims) },
  )
}

/** TRANSACTION_ALREADY_STAGED as an operation outcome, for the v1 stage mode. */
export function transactionAlreadyStagedFailure(claims: TransactionClaim[]): {
  ok: false
  code: string
  details: Record<string, unknown>
} {
  return { ok: false, code: TRANSACTION_ALREADY_STAGED, details: claimDetails(claims) }
}
