import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import { capabilityBlockedError } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { createLogger, type Logger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { createServiceClient } from '@/lib/supabase/server'
import { loadCollectionsGateFacts } from './availability'
import {
  batchParamsSchema,
  batchSkipReason,
  remainingBatchItems,
  type BatchCommitResult,
  type BatchItem,
  type BatchParams,
  type BatchSkip,
} from './batch'
import { loadBatchRemovals } from './batch-removals'
import { loadOpenCaseForInvoice } from './case'
import { handOverInvoice, loadLedgerRemaining, runCaseAction, type CaseActionOutcome } from './case-actions'
import { collectionsErrorMessage, isCollectionsError } from './errors'
import { collectionsGate, readCollectionsEnv, type CollectionsEnv, type CollectionsGateFacts } from './flags'
import { openCollectionCase, type OpenCaseOutcome } from './open-case'
import { HandoverNotFoundError } from './readiness'
import type { CollectionsActor, CollectionsServiceDeps } from './service-deps'

/**
 * Commit an approved daily collections batch (build spec 3.6). Runs only
 * from the staged-operation commit (commitPendingOperation) after an
 * administrator approved the batch in the web UI: the type is web-only
 * (risk-tiers.ts requiresWebApproval) and batchApprovalRefusal is asked
 * before the operation is claimed.
 *
 * The staged items less the ones an administrator took out are decided
 * again, one by one, with the same services
 * a person's own click uses: a new handover (open-case.ts), reminders on a
 * delivered invoice and the approval of the next step (case-actions.ts).
 * Those re-run eligibility and the bank check (fresh within 24 hours) and
 * refuse an item whose remaining amount changed since the batch was
 * gathered. No attestation is given here: an item that would need one is
 * skipped. Every skip carries one reason.
 *
 * Idempotency: a new handover's case id is a deterministic uuid v5 of the
 * operation, the invoice and the kind, so a commit that runs again after a
 * crash finds the case it already opened instead of opening a second one.
 */

const log = createLogger('collections/batch-commit')

/** The namespace of the batch item case ids (uuid v5). Fixed: changing it changes every derived id. */
const BATCH_ITEM_NAMESPACE = '3f8e2b6a-5c1d-4e7f-9a2b-6c8d0e1f2a3b'

/** RFC 4122 version 5 (SHA-1, name-based) uuid. */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The case id (and the provider's idempotency key) of a batch item's new handover. */
export function batchItemCaseId(operationId: string, invoiceId: string, kind: BatchItem['kind']): string {
  return uuidV5(`${operationId}:${invoiceId}:${kind}`, BATCH_ITEM_NAMESPACE)
}

export interface BatchApprovalRefusal {
  code: string
  status: number
  messageSv: string
}

export interface BatchApprovalDeps {
  env?: CollectionsEnv
  isAdmin?: (supabase: SupabaseClient, companyId: string) => Promise<boolean>
  loadFacts?: (supabase: SupabaseClient, companyId: string) => Promise<CollectionsGateFacts>
}

/**
 * Asked before the batch is claimed, so a refused batch stays pending: the
 * approver must be the company's owner or an administrator, and the daily
 * batch's start gates must still say yes (kill switch, pilot list, ladder
 * flag, the paid capability, an active connection with the ladder staged).
 * Runs with the approver's own client.
 */
export async function batchApprovalRefusal(
  supabase: SupabaseClient,
  companyId: string,
  deps: BatchApprovalDeps = {},
): Promise<BatchApprovalRefusal | null> {
  const admin = await (deps.isAdmin ?? isCompanyAdmin)(supabase, companyId)
  if (!admin) {
    return {
      code: 'COLLECTION_BATCH_ADMIN_ONLY',
      status: 403,
      messageSv: getErrorEntry('COLLECTION_BATCH_ADMIN_ONLY')?.message_sv ?? 'Bara företagets ägare eller en administratör kan godkänna omgången.',
    }
  }
  const facts = await (deps.loadFacts ?? loadCollectionsGateFacts)(supabase, companyId)
  const decision = collectionsGate('daily_batch', facts, deps.env ?? readCollectionsEnv())
  if (decision.allowed) return null
  if (decision.code === 'CAPABILITY_REQUIRED') {
    return { code: 'capability_blocked', status: 403, messageSv: capabilityBlockedError(CAPABILITY.collections).message_sv }
  }
  return {
    code: decision.code,
    status: decision.status,
    messageSv: collectionsErrorMessage(decision.code, { provider: facts.connection?.displayName ?? null }),
  }
}

export interface CommitBatchInput {
  /** The approver's own client (gate facts). */
  supabase: SupabaseClient
  userId: string
  /** How the approver is named in the case trail (e-mail when known). */
  userLabel?: string | null
  companyId: string
  operation: { id: string; params: Record<string, unknown> }
}

export interface CommitBatchDeps {
  /** Service-role client for the case services; default createServiceClient(). */
  db?: SupabaseClient
  env?: CollectionsEnv
  facts?: CollectionsGateFacts
  now?: () => Date
  log?: Logger
  adapterFor?: CollectionsServiceDeps['adapterFor']
}

export type CommitBatchOutcome =
  | { ok: true; data: BatchCommitResult }
  | { ok: false; code: string; status: number; message: string }

/** Which items' customers are now marked "Skicka aldrig till inkasso". */
async function excludedInvoiceIds(db: Pick<SupabaseClient, 'from'>, companyId: string, invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set()
  const { data, error } = await db
    .from('invoices')
    .select('id, customer:customers(collections_excluded)')
    .eq('company_id', companyId)
    .in('id', invoiceIds)
  if (error) throw new Error(`batch customers lookup failed: ${error.message}`)
  const out = new Set<string>()
  for (const row of (data ?? []) as Array<{ id: string; customer: unknown }>) {
    const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as { collections_excluded?: boolean } | null
    if (customer?.collections_excluded === true) out.add(row.id)
  }
  return out
}

type ItemOutcome = { done: true; caseId: string | null } | { done: false; skip: Omit<BatchSkip, 'invoice_id' | 'kind'> }

function skipOf(code: string, details?: Record<string, unknown>, upstream = false): ItemOutcome {
  return { done: false, skip: { reason: batchSkipReason(code, details, upstream), code } }
}

function fromServiceOutcome(outcome: OpenCaseOutcome | CaseActionOutcome): ItemOutcome {
  if (outcome.ok) return { done: true, caseId: 'case' in outcome ? outcome.case.id : null }
  return skipOf(outcome.upstream ? outcome.upstream.code : outcome.code, outcome.details, !!outcome.upstream)
}

async function commitItem(
  deps: CollectionsServiceDeps,
  operationId: string,
  item: BatchItem,
  excluded: ReadonlySet<string>,
): Promise<ItemOutcome> {
  const { db, companyId } = deps
  if (excluded.has(item.invoice_id)) return skipOf('COLLECTION_CUSTOMER_EXCLUDED')

  if (item.kind === 'open') {
    const caseId = batchItemCaseId(operationId, item.invoice_id, 'open')
    // A commit that runs again after a crash: this batch already opened the case.
    const { data: existing, error } = await db
      .from('collection_cases')
      .select('id')
      .eq('company_id', companyId)
      .eq('id', caseId)
      .maybeSingle()
    if (error) throw new Error(`collection_cases lookup failed: ${error.message}`)
    if (existing) return { done: true, caseId }
    return fromServiceOutcome(
      await openCollectionCase(deps, {
        invoiceId: item.invoice_id,
        startStep: item.start_step,
        expectedRemaining: item.remaining_amount,
        origin: 'batch',
        caseId,
        pendingOperationId: operationId,
      }),
    )
  }

  // start and approve_step act on the case the person saw, nothing else.
  const open = await loadOpenCaseForInvoice(db, companyId, item.invoice_id)
  if (!open || open.id !== item.case_id) return skipOf('COLLECTION_CASE_NOT_FOUND')

  if (item.kind === 'start') {
    if (open.stage !== 'invoice_sent') return skipOf('CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE')
    return fromServiceOutcome(
      await handOverInvoice(deps, {
        invoiceId: item.invoice_id,
        startStep: item.start_step,
        expectedRemaining: item.remaining_amount,
        origin: 'batch',
        pendingOperationId: operationId,
      }),
    )
  }

  if (open.stage !== 'awaiting_decision' || open.decision_kind !== item.decision_kind) {
    return skipOf('CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE')
  }
  let ledgerRemaining: number
  try {
    ledgerRemaining = (await loadLedgerRemaining(db, companyId, item.invoice_id)).ledgerRemaining
  } catch (err) {
    if (err instanceof HandoverNotFoundError) return skipOf('INVOICE_NOT_FOUND')
    throw err
  }
  if (roundOre(ledgerRemaining) !== roundOre(item.remaining_amount)) return skipOf('COLLECTION_REMAINING_CHANGED')
  return fromServiceOutcome(await runCaseAction(deps, { invoiceId: item.invoice_id, action: 'approve_step' }))
}

/**
 * Send the approved batch, item by item. One item's failure never stops the
 * others: it is skipped with its reason, and the person can act on that
 * invoice from its page.
 */
export async function commitCollectionsDailyBatch(input: CommitBatchInput, deps: CommitBatchDeps = {}): Promise<CommitBatchOutcome> {
  const parsed = batchParamsSchema.safeParse(input.operation.params)
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_ERROR', status: 400, message: 'Omgången kunde inte läsas.' }
  }
  const params: BatchParams = parsed.data
  const db = deps.db ?? createServiceClient()
  const env = deps.env ?? readCollectionsEnv()
  const logger = deps.log ?? log
  const actor: CollectionsActor = { userId: input.userId, name: input.userLabel?.trim() || input.userId }
  const serviceDeps: CollectionsServiceDeps = {
    db,
    companyId: input.companyId,
    actor,
    // A person approved the batch in the web UI; no attestation is given, so
    // an item that needs one is skipped.
    channel: 'web',
    facts: deps.facts ?? (await loadCollectionsGateFacts(input.supabase, input.companyId)),
    env,
    now: deps.now,
    log: logger,
    adapterFor: deps.adapterFor,
  }

  // Read after the claim: a removal either landed before it or was refused
  // (remove_collection_batch_items locks the batch row and wants it pending).
  const items = remainingBatchItems(params, await loadBatchRemovals(db, input.companyId, input.operation.id))
  const excluded = await excludedInvoiceIds(db, input.companyId, items.map((i) => i.invoice_id))
  const done: BatchCommitResult['done'] = []
  const skipped: BatchSkip[] = []
  for (const item of items) {
    let outcome: ItemOutcome
    try {
      outcome = await commitItem(serviceDeps, input.operation.id, item, excluded)
    } catch (err) {
      logger.error('collections batch item failed', err as Error, { invoiceId: item.invoice_id, kind: item.kind })
      outcome = isCollectionsError(err) ? skipOf(err.code, undefined, true) : skipOf('INTERNAL_ERROR')
    }
    if (outcome.done) done.push({ invoice_id: item.invoice_id, kind: item.kind, case_id: outcome.caseId })
    else skipped.push({ invoice_id: item.invoice_id, kind: item.kind, ...outcome.skip })
  }
  return {
    ok: true,
    data: { batch_date: params.batch_date, done, skipped, done_count: done.length, skipped_count: skipped.length },
  }
}
