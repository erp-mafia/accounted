/**
 * Approve a pending operation as an API key: the v1 REST approval door
 * (POST /api/v1/companies/{companyId}/pending-operations/{id}/approve).
 *
 * The commit is commitPendingOperation, the one executor every approval door
 * ends in (the /pending review list, bulk approval, the MCP approve tool).
 * Its atomic pending -> committing claim is what makes a second approval of
 * the same operation commit nothing: only the caller whose conditional
 * UPDATE matched runs the executor. This file only adds what an API-key door
 * owes the record, the same things the MCP approve tool records for its
 * approvals:
 *
 *   - commit_method 'api_key' and the key as the commit actor, so every
 *     journal entry the operation posts says a credential relayed the
 *     approval, not a first-party session (BFNAR 2013:2 behandlingshistorik);
 *     a key minted by the MCP OAuth sign-in says mcp_oauth, a service
 *     account's key says service_account with the account's name;
 *   - the key's unattended ceiling, enforced inside the commit;
 *   - the user's e-mail for attribution (committed_by_email, send_invoice cc);
 *   - one PendingOperationApproved processing-history row per attempt, with
 *     channel 'api';
 *   - the gates the MCP tool applies before it commits: an operation only a
 *     person may approve in the web app is refused, and a high-risk one needs
 *     the caller's explicit confirmation (BFL 5 kap. 5 §).
 *
 * Deliberately separate from the MCP approve tool (the MCP extension, which
 * core code may not import): both call the same commit, and the door rules
 * above are short enough that sharing them would mean moving the tool.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import type { Logger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import type { PendingOperation } from '@/types'
import { commitPendingOperation, type CommitResult } from './commit'
import { requiresWebApproval } from './risk-tiers'

export interface ApiKeyApprover {
  userId: string
  apiKeyId: string | undefined
  /** Who the key is in the records (credentialActor); userId is a service account's sponsor. */
  actor: Pick<CommitActor, 'type' | 'label'>
  unattendedCommitLimit: number | null
}

export type ApiApprovalResult =
  | { kind: 'not_found' }
  /** Already resolved, or claimed by a concurrent approval: nothing was run. */
  | { kind: 'not_pending'; operation: PendingOperation }
  /** Only a person approving in the web app may commit it (collections). */
  | { kind: 'web_only'; operation: PendingOperation }
  /** risk_level high without confirmed=true. */
  | { kind: 'confirmation_required'; operation: PendingOperation }
  | { kind: 'committed'; operation: PendingOperation; result: CommitResult }
  /** The commit ran and refused or failed; `operation` is the row as it now stands. */
  | { kind: 'failed'; operation: PendingOperation; result: CommitResult }

async function loadOperation(
  supabase: SupabaseClient,
  companyId: string,
  operationId: string,
): Promise<PendingOperation | null> {
  const { data, error } = await supabase
    .from('pending_operations')
    .select('*')
    .eq('id', operationId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return (data as PendingOperation | null) ?? null
}

async function resolveUserEmail(supabase: SupabaseClient, userId: string, log: Logger): Promise<string | undefined> {
  try {
    const { data } = await supabase.auth.admin.getUserById(userId)
    return data.user?.email ?? undefined
  } catch (err) {
    log.warn('failed to resolve user email for API approval', {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

export async function approvePendingOperationAsApiKey(
  supabase: SupabaseClient,
  params: {
    companyId: string
    operationId: string
    confirmed: boolean
    approver: ApiKeyApprover
    log: Logger
  },
): Promise<ApiApprovalResult> {
  const { companyId, operationId, confirmed, approver, log } = params

  const operation = await loadOperation(supabase, companyId, operationId)
  if (!operation) return { kind: 'not_found' }
  if (operation.status !== 'pending') return { kind: 'not_pending', operation }
  if (requiresWebApproval(operation.operation_type, operation.params)) return { kind: 'web_only', operation }
  if (operation.risk_level === 'high' && !confirmed) return { kind: 'confirmation_required', operation }

  const { type: commitActorType, label } = approver.actor
  const userEmail = await resolveUserEmail(supabase, approver.userId, log)

  const result = await commitPendingOperation(supabase, approver.userId, companyId, operation, {
    commitMethod: 'api_key',
    actor: {
      type: commitActorType,
      ...(label ? { label } : {}),
      unattendedCommitLimit: approver.unattendedCommitLimit,
    },
    ...(userEmail ? { userEmail } : {}),
  })

  // Best effort, as on the MCP door: the commit's side effects already exist.
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: operation.id,
      aggregateType: 'System',
      aggregateId: operation.id,
      eventType: 'PendingOperationApproved',
      payload: {
        operation_id: operation.id,
        operation_type: operation.operation_type,
        risk_level: operation.risk_level,
        outcome: result.status,
        commit_method: 'api_key',
        channel: 'api',
        confirmed,
      },
      // A service account's key is named as the service account here too, as
      // on the commit above. The history's word for any other key is api_key.
      actor: {
        type: commitActorType === 'service_account' ? 'service_account' : 'api_key',
        id: approver.apiKeyId ?? approver.userId,
        ...(label ? { label } : {}),
      },
      occurredAt: new Date(),
    })
  } catch (err) {
    log.warn('failed to append PendingOperationApproved audit event', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.status === 'committed') {
    return {
      kind: 'committed',
      result,
      operation: {
        ...operation,
        status: 'committed',
        result_data: result.data ?? {},
        resolved_at: new Date().toISOString(),
      },
    }
  }

  // The row as the commit left it: released to pending (re-approvable),
  // rejected, failed_partial, or still claimed by another approval.
  const current = (await loadOperation(supabase, companyId, operationId).catch(() => null)) ?? operation
  // Lost the pending -> committing claim: another approval of this operation
  // is running or has finished. Nothing ran here.
  if (result.http_status === 409 && result.operation_status === undefined) {
    return { kind: 'not_pending', operation: current }
  }
  return { kind: 'failed', result, operation: current }
}
