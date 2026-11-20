import { chunk } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { createLogger } from '@/lib/logger'
import { traceIdColumn, writeWithTraceId } from '@/lib/observability/trace-column'
import { agentReasonColumn, writeWithAgentReason } from '@/lib/pending-operations/agent-reason'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { PendingOperation } from '@/types'
import { grantPolicyVersion } from '@/lib/grants/types'
import { operationInputHash } from './provenance'
import type { ApprovalDoor } from './approval-door'

/**
 * Decision receipts for approved staged operations.
 *
 * A write staged by an agent, a key or a person (MCP, REST ?stage=true, the
 * Att göra list) is decided when it is approved, and commitPendingOperation
 * commits it. Once the commit has succeeded, this writes one suggestion_log
 * row of kind 'operation' for every voucher the approval posted, so the
 * receipt reader (./receipts.ts) answers GET /journal-entries/{id} with a
 * receipt that names:
 *   - the operation (pending_operation_id), and through it who staged it,
 *     with which model, when (the reader joins the pending_operations row);
 *   - who approved it (actor_type, resolved_by; the voucher's committed actor
 *     columns carry the credential label and commit method);
 *   - what was approved (input_hash: the params the commit ran and the
 *     preview the approver was shown, ./provenance.ts);
 *   - the policy that let it through (policy_version, confidence_band):
 *     review when a person approved it (in Accounted, or with a click in the
 *     approval view inside the AI client: door=mcp_view), direct when a
 *     credential approved it under its unattended ceiling (the AI's own call
 *     over MCP: door=mcp_chat), and direct under the company grant that let
 *     it through without a person (grant.<revision>;grant_id=...;
 *     grant_version=..., lib/grants). An approver of any other kind records
 *     neither, as a policy is never recorded without its band.
 * The stager's reason (pending_operations.agent_reason) is copied as the
 * row's agent_reason, as the bank-line and underlag doors copy it.
 * The one suggestion on offer is the staged operation, acted on as staged
 * (acted_on 0, outcome 'accepted'): an approval books what was staged or
 * nothing. checks stays null (the commit door does not report the
 * executor's guards) and rule_version null (no rules produced the proposal).
 *
 * Which vouchers: the ids the operation's result names under a key ending in
 * entry_id or entry_ids, kept only when the voucher was posted at or after
 * the approval claimed the operation. A voucher the operation merely refers
 * to (the one a document is linked to, the original of a storno) was posted
 * before the claim and gets no receipt it did not earn.
 *
 * At most one receipt per voucher and operation. A door that recorded the
 * decision inside the commit (a bank line categorized, an underlag booked;
 * those rows carry the same pending_operation_id) is the richer record and
 * wins; a voucher that already has a row for this operation is skipped, so a
 * repeated call writes nothing. The approval's atomic claim already lets only
 * one caller run the commit. One exception: a commit under a grant also
 * writes its operation row beside the door's bank-line row, because the
 * bank-line row says what was on offer while only the operation row can say
 * which company rule decided it without a person (its band needs an
 * acted-on suggestion, which the staged operation is). Still at most one
 * operation row per voucher and operation.
 *
 * Never a precondition for the commit: it runs after the commit succeeded,
 * and every failure is logged and dropped, as in the bank-line and underlag
 * writers. The record of truth stays the voucher's actor columns, the
 * pending_operations row and audit_log; the receipt links them.
 */

const log = createLogger('suggestion-log')

export const STAGED_APPROVAL_POLICY_REVISION = 1
const POLICY = `staged-approval.${STAGED_APPROVAL_POLICY_REVISION}`

/** The most vouchers one approval records receipts for. */
export const MAX_OPERATION_RECEIPTS = 500

const ID_CHUNK = 200
const MAX_DEPTH = 4
const ENTRY_KEY = /(^|_)entry_ids?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Key credentials: an API key, an OAuth connector's minted key, a service account's key. */
const CREDENTIAL_ACTORS: ReadonlySet<CommitActor['type']> = new Set(['api_key', 'mcp_oauth', 'service_account'])

/**
 * The voucher ids a committed result names, in the order it names them:
 * strings under a key ending in entry_id or entry_ids, at any depth up to
 * MAX_DEPTH (bulk results nest them in lists).
 */
export function entryIdsNamedIn(result: unknown): string[] {
  const ids = new Set<string>()
  const visit = (value: unknown, depth: number, named: boolean): void => {
    if (ids.size >= MAX_OPERATION_RECEIPTS) return
    if (typeof value === 'string') {
      if (named && UUID.test(value)) ids.add(value.toLowerCase())
      return
    }
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, named)
      return
    }
    for (const [key, item] of Object.entries(value)) visit(item, depth + 1, ENTRY_KEY.test(key))
  }
  visit(result, 0, false)
  return [...ids]
}

export interface ApprovalPolicy {
  policyVersion: string | null
  band: 'direct' | 'review' | null
}

/**
 * The approval policy a commit ran under, read off who approved it. A person
 * reviewed the staged proposal; a key credential finished it unattended,
 * within its ceiling (none when the key has no positive limit), or carried a
 * person's click from the approval view (door mcp_view: a review, with the
 * key's ceiling still applied).
 */
export function approvalPolicy(
  actor: CommitActor | undefined,
  grant?: { grantId: string; grantVersion: number } | null,
  door?: ApprovalDoor | null,
): ApprovalPolicy {
  // A company grant decided it: the rule, not the credential, is the policy.
  if (grant && actor && CREDENTIAL_ACTORS.has(actor.type)) {
    return { policyVersion: grantPolicyVersion(grant), band: 'direct' }
  }
  if (actor?.type === 'user') return { policyVersion: `${POLICY};approver=person`, band: 'review' }
  if (actor && CREDENTIAL_ACTORS.has(actor.type)) {
    const limit =
      typeof actor.unattendedCommitLimit === 'number' && actor.unattendedCommitLimit > 0
        ? String(actor.unattendedCommitLimit)
        : 'none'
    if (door === 'mcp_view') {
      return { policyVersion: `${POLICY};approver=person_in_client;unattended_limit=${limit};door=mcp_view`, band: 'review' }
    }
    const doorPart = door ? `;door=${door}` : ''
    return { policyVersion: `${POLICY};approver=credential;unattended_limit=${limit}${doorPart}`, band: 'direct' }
  }
  return { policyVersion: null, band: null }
}

export interface OperationDecision {
  companyId: string
  /** The approving user: the person, or the key's owner (a service account's sponsor). */
  userId: string
  operation: Pick<PendingOperation, 'id' | 'operation_type' | 'params' | 'preview_data' | 'risk_level' | 'agent_metadata' | 'agent_reason'>
  /** What the commit answered (pending_operations.result_data). */
  resultData: Record<string, unknown> | null | undefined
  /**
   * When the approval claimed the operation, on the database clock (the
   * claim's updated_at). Null when unknown: then nothing is recorded, as
   * posted-by-this-approval cannot be told from referred-to.
   */
  claimedAt: string | null
  /** Who approved (commitPendingOperation's opts.actor). */
  actor: CommitActor | undefined
  /** The company grant that let the operation through without a person (commitPendingOperation's opts.grant). */
  grant?: { grantId: string; grantVersion: number } | null
  /** Where a key credential's approval came from (commitPendingOperation's opts.approvalDoor). */
  door?: ApprovalDoor | null
}

/**
 * The rows for `entries`, one per voucher; `posted` is every voucher the
 * approval posted. `agentReason` defaults to the operation's; `traceId` is
 * the request that records the approval (lib/observability/trace-context.ts).
 */
export function buildOperationDecisionRows(
  decision: OperationDecision,
  entries: string[],
  posted: string[],
  agentReason: string | null = decision.operation.agent_reason ?? null,
  traceId: string | null = null,
) {
  const { operation, actor } = decision
  const policy = approvalPolicy(actor, decision.grant, decision.door)
  const model = typeof operation.agent_metadata?.model === 'string' ? operation.agent_metadata.model : null
  const suggestion = {
    source: 'pending_operation',
    source_id: operation.id,
    rank: 0,
    proposal: { operation_type: operation.operation_type, risk_level: operation.risk_level ?? null },
    confidence: null,
    model,
    prompt_sha256: null,
    matches_final: true,
  }
  const inputHash = operationInputHash({
    operationType: operation.operation_type,
    params: operation.params,
    preview: operation.preview_data,
  })
  return entries.map((journalEntryId) => ({
    company_id: decision.companyId,
    kind: 'operation' as const,
    pending_operation_id: operation.id,
    suggestions: [suggestion],
    acted_on: 0,
    final: { journal_entry_id: journalEntryId, operation_type: operation.operation_type, journal_entry_ids: posted },
    outcome: 'accepted' as const,
    actor_type: actor?.type ?? 'user',
    resolved_by: decision.userId,
    rule_version: null,
    policy_version: policy.policyVersion,
    confidence_band: policy.band,
    input_hash: inputHash,
    checks: null,
    ...traceIdColumn(traceId),
    // Why the stager proposed it, as the approver saw it.
    ...agentReasonColumn(agentReason),
  }))
}

/** The ids among `ids` posted at or after `since`, in the order given. */
async function postedSince(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
  since: string,
): Promise<string[]> {
  const posted = new Set<string>()
  for (const part of chunk(ids, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', companyId)
      .in('id', part)
      .gte('committed_at', since)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as Array<{ id: string }>) posted.add(row.id)
  }
  return ids.filter((id) => posted.has(id))
}

/**
 * The vouchers already recorded for this operation, by a door or an earlier
 * call; under a grant only the operation rows count (see the header).
 */
async function recordedEntries(
  supabase: SupabaseClient,
  companyId: string,
  operationId: string,
  onlyOperationRows: boolean,
): Promise<Set<string>> {
  const rows = await fetchAllRows<{ id: string; journal_entry_id: string | null }>(({ from, to }) => {
    const query = supabase
      .from('suggestion_log')
      .select('id, journal_entry_id:final->>journal_entry_id')
      .eq('company_id', companyId)
      .eq('pending_operation_id', operationId)
    return (onlyOperationRows ? query.eq('kind', 'operation') : query).order('id', { ascending: true }).range(from, to)
  })
  return new Set(rows.map((r) => r.journal_entry_id).filter((id): id is string => !!id))
}

/**
 * Record the approval of a committed operation: one receipt per voucher it
 * posted that no row records yet. Returns how many rows were written; never
 * throws.
 */
export async function recordOperationDecision(supabase: SupabaseClient, decision: OperationDecision): Promise<number> {
  if (!decision.claimedAt) return 0
  try {
    const named = entryIdsNamedIn(decision.resultData)
    if (named.length === 0) return 0
    const posted = await postedSince(supabase, decision.companyId, named, decision.claimedAt)
    if (posted.length === 0) return 0
    const recorded = await recordedEntries(supabase, decision.companyId, decision.operation.id, !!decision.grant)
    const entries = posted.filter((id) => !recorded.has(id))
    if (entries.length === 0) return 0
    const { error } = await writeWithTraceId((traceId) =>
      writeWithAgentReason(decision.operation.agent_reason, (agentReason) =>
        supabase.from('suggestion_log').insert(buildOperationDecisionRows(decision, entries, posted, agentReason, traceId)),
      ),
    )
    if (error) throw new Error(error.message)
    return entries.length
  } catch (err) {
    log.error('failed to record the staged operation decision (commit unaffected)', {
      companyId: decision.companyId,
      pendingOperationId: decision.operation.id,
      operationType: decision.operation.operation_type,
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
