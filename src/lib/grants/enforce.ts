/**
 * Enforcement: a staged operation goes through without a person only when
 * it matches one of the company's active grants exactly.
 *
 * Called by a staging door right after it staged an operation for a key
 * credential (today the MCP server, after gnubok_categorize_transaction).
 * The door's own staging is untouched: this runs after it, on the staged
 * row, and never fails the staging.
 *
 *   1. claim_company_grant (migration 20261017100400) is the one gate. Under
 *      a lock on the operation and the grant it checks, in SQL against what
 *      the database holds now, everything a grant requires: the kill switch,
 *      the key (live, not revoked, the one that staged it, still a writing
 *      member or an active service account), the plain booking (no duplicate
 *      override, no VAT amount, no dimensions), a bank line with a counterparty
 *      identity and nothing booked on it yet, an open unlocked period, an
 *      active grant for exactly that counterparty, the identical pattern
 *      (direction, category, VAT treatment, account and every account the
 *      posting touches), the named credential, the limit per posting, the
 *      key's own unattended ceiling (the stricter wins) and the monthly
 *      limit. A match is recorded as a claimed company_grant_uses row; any
 *      refusal changes nothing.
 *   2. On a match the operation is committed through commitPendingOperation,
 *      the executor every approval door ends in, as the key credential that
 *      staged it (commit_method api_key, its unattended ceiling enforced
 *      again in TypeScript) and under the grant: the pending operation's
 *      result_data and the decision receipt name the grant and its version
 *      (policy grant.<revision>;grant_id=...;grant_version=..., band direct).
 *   3. The outcome is reported back: complete_company_grant_use records the
 *      verifikat and checks its posted lines against the grant; a refused
 *      commit releases the claim, and the operation is wherever the commit
 *      left it (pending for a person in every recoverable case).
 *
 * Deploy order: before the migrations run, claim_company_grant does not
 * exist; the answer is "no grant" and the operation waits for a person, as
 * it always has. Every failure here is logged and answered the same way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { commitPendingOperation, type CommitResult } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'
import { grantsEnabled } from './flag'
import { SILENT_GRANT_REFUSALS } from './types'

/** The credential that staged the operation, as the staging door validated it. */
export interface GrantCredential {
  /** The commit actor type: a person's key, an OAuth connector's minted key, or a service account's key. */
  actorType: 'api_key' | 'mcp_oauth' | 'service_account'
  /** api_keys.id of the key that staged the operation. */
  apiKeyId: string
  /** Display label stamped on the verifikat (the key's name, the client, or the service account's name). */
  label?: string
  /** The key's unattended ceiling in SEK (api_keys.unattended_commit_limit), null for none. */
  unattendedCommitLimit: number | null
}

export interface AppliedGrant {
  grant_id: string
  grant_version: number
  use_id: string
  amount_sek: number
  counterparty_label: string | null
  accepted_at: string | null
}

export type GrantOutcome =
  /** No grant applied: the operation waits for a person, as before. */
  | { applied: false; reason: string; detail?: Record<string, unknown> }
  /** A grant matched and the commit booked it. */
  | { applied: true; committed: true; grant: AppliedGrant; journalEntryId: string | null; patternVerified: boolean | null; result: CommitResult }
  /** A grant matched but the commit refused: the claim is released and the operation is where the commit left it. */
  | { applied: true; committed: false; grant: AppliedGrant; result: CommitResult }

/** PostgREST / Postgres codes meaning "the grant functions are not in this database yet". */
const NOT_IN_DATABASE_CODES: ReadonlySet<string> = new Set(['42883', '42P01', 'PGRST202', 'PGRST205'])

interface ClaimResult {
  matched: boolean
  reason?: string
  company_id?: string
  grant_id?: string
  grant_version?: number
  use_id?: string
  amount_sek?: number | string
  counterparty_label?: string
  accepted_at?: string
  [key: string]: unknown
}

function detailOf(claim: ClaimResult): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {}
  for (const key of ['grant_id', 'amount_sek', 'limit_sek', 'used_sek']) {
    if (claim[key] !== undefined && claim[key] !== null) detail[key] = claim[key]
  }
  return Object.keys(detail).length > 0 ? detail : undefined
}

export async function applyCompanyGrant(
  supabase: SupabaseClient,
  input: {
    companyId: string
    userId: string
    operationId: string
    credential: GrantCredential
    userEmail?: string
    log: Logger
  },
): Promise<GrantOutcome> {
  const { companyId, userId, operationId, credential, log } = input
  // The master switch: off, no grant applies and the gate is never asked.
  if (!grantsEnabled()) return { applied: false, reason: 'switched_off' }
  if (!credential.apiKeyId) return { applied: false, reason: 'not_a_key_credential' }

  let claim: ClaimResult
  try {
    const { data, error } = await supabase.rpc('claim_company_grant', {
      p_pending_operation_id: operationId,
      p_api_key_id: credential.apiKeyId,
    })
    if (error) {
      if (error.code && NOT_IN_DATABASE_CODES.has(error.code)) return { applied: false, reason: 'not_in_database' }
      log.warn('grant claim failed; the operation waits for a person', { operationId, code: error.code, error: error.message })
      return { applied: false, reason: 'claim_failed' }
    }
    claim = (data ?? { matched: false, reason: 'no_answer' }) as ClaimResult
  } catch (err) {
    log.warn('grant claim failed; the operation waits for a person', {
      operationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { applied: false, reason: 'claim_failed' }
  }

  if (!claim.matched || !claim.grant_id || !claim.use_id || typeof claim.grant_version !== 'number') {
    const reason = claim.reason ?? 'no_grant'
    if (!SILENT_GRANT_REFUSALS.has(reason)) log.info('grant did not apply', { operationId, reason })
    const detail = detailOf(claim)
    return { applied: false, reason, ...(detail ? { detail } : {}) }
  }

  const grant: AppliedGrant = {
    grant_id: claim.grant_id,
    grant_version: claim.grant_version,
    use_id: claim.use_id,
    amount_sek: Number(claim.amount_sek),
    counterparty_label: claim.counterparty_label ?? null,
    accepted_at: claim.accepted_at ?? null,
  }

  // The claim locked and checked the row as the database held it; the commit
  // reads it again and claims it pending -> committing on its own.
  const release = async (reason: string) => {
    try {
      const { error } = await supabase.rpc('release_company_grant_use', { p_use_id: grant.use_id, p_reason: reason })
      if (error) throw new Error(error.message)
    } catch (err) {
      log.error('grant claim could not be released (the claim expires from the monthly count after an hour)', {
        operationId,
        useId: grant.use_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (claim.company_id && claim.company_id !== companyId) {
    await release('company_mismatch')
    return { applied: false, reason: 'credential_mismatch' }
  }

  const { data: row, error: rowError } = await supabase
    .from('pending_operations')
    .select('*')
    .eq('id', operationId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (rowError || !row) {
    await release('operation_unreadable')
    return { applied: false, reason: 'operation_not_found' }
  }

  let result: CommitResult
  try {
    result = await commitPendingOperation(supabase, userId, companyId, row as PendingOperation, {
      commitMethod: 'api_key',
      actor: {
        type: credential.actorType,
        ...(credential.label ? { label: credential.label } : {}),
        unattendedCommitLimit: credential.unattendedCommitLimit,
      },
      grant: { grantId: grant.grant_id, grantVersion: grant.grant_version, useId: grant.use_id },
      ...(input.userEmail ? { userEmail: input.userEmail } : {}),
    })
  } catch (err) {
    // A throw from the commit (a typed bookkeeping error, a dropped
    // connection) is the commit's to classify for an approval door; here the
    // staging already answered, so it is reported as a refused commit.
    log.error('commit under a grant threw', err instanceof Error ? err : new Error(String(err)), { operationId })
    await release('commit_threw')
    const failed: CommitResult = { status: 'failed', error: err instanceof Error ? err.message : String(err), http_status: 500 }
    return { applied: true, committed: false, grant, result: failed }
  }

  // The record of the unattended approval, as the approve doors write one.
  try {
    await appendProcessingHistory({
      companyId,
      correlationId: operationId,
      aggregateType: 'System',
      aggregateId: operationId,
      eventType: 'PendingOperationApproved',
      payload: {
        operation_id: operationId,
        operation_type: (row as PendingOperation).operation_type,
        risk_level: (row as PendingOperation).risk_level,
        outcome: result.status,
        commit_method: 'api_key',
        channel: 'grant',
        grant_id: grant.grant_id,
        grant_version: grant.grant_version,
        grant_use_id: grant.use_id,
      },
      actor: {
        type: credential.actorType === 'service_account' ? 'service_account' : 'api_key',
        id: credential.apiKeyId,
        ...(credential.label ? { label: credential.label } : {}),
      },
      occurredAt: new Date(),
    })
  } catch (err) {
    log.warn('failed to append PendingOperationApproved for a grant commit', {
      operationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.status !== 'committed') {
    await release(result.code ?? `commit_${result.status}`)
    return { applied: true, committed: false, grant, result }
  }

  const journalEntryId = typeof result.data?.journal_entry_id === 'string' ? result.data.journal_entry_id : null
  let patternVerified: boolean | null = null
  try {
    const { data, error } = await supabase.rpc('complete_company_grant_use', {
      p_use_id: grant.use_id,
      p_journal_entry_id: journalEntryId,
    })
    if (error) throw new Error(error.message)
    const verified = (data as { pattern_verified?: unknown } | null)?.pattern_verified
    patternVerified = typeof verified === 'boolean' ? verified : null
    if (patternVerified === false) {
      log.error('a posting under a grant does not match the grant (shown for review)', {
        operationId,
        grantId: grant.grant_id,
        journalEntryId,
      })
    }
  } catch (err) {
    // The verifikat is posted and the operation's result_data names the use:
    // the review list still shows it (list_company_grant_postings).
    log.error('grant use could not be completed after the commit', {
      operationId,
      useId: grant.use_id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return { applied: true, committed: true, grant, journalEntryId, patternVerified, result }
}
