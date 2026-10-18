/**
 * The commit side of create_grant and revoke_grant: what the two staged
 * operations run once an owner or admin approved them
 * (lib/pending-operations/commit.ts), for a bank-line rule and a
 * supplier-invoice rule alike.
 *
 * create_company_grant and revoke_company_grant (migration 20261017100300)
 * are the authority: they re-check that the approver is an owner or admin,
 * refuse a service account relaying the decision, write the rule (a new
 * version superseding the active one, or the revocation) and the audit_log
 * row behandlingshistorik shows as a dated line. They run through the
 * service role on every path, an approval in the app included (a session
 * client may not call them).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { CreateGrantParams, RevokeGrantParams } from './types'

export interface GrantDecisionInput {
  companyId: string
  /** The approver each commit path verified (a key's owner for a key). */
  userId: string
  pendingOperationId: string
  /** The credential that relayed the approval. */
  actor: { type: string; label?: string | null }
}

export type GrantCommitFailure = { ok: false; code: string; message_sv: string; status: number }

export type CreateGrantResult =
  | {
      ok: true
      data: {
        grant_id: string
        version: number
        superseded_grant_id: string | null
        counterparty_label: string
        amount_limit_sek: number
        valid_from: string | null
      }
    }
  | GrantCommitFailure

export interface RevokedPosting {
  use_id: string
  journal_entry_id: string | null
  transaction_id: string | null
  /** A supplier-invoice rule's posting: the inbox item and the supplier invoice (absent before migration 20261018100200). */
  inbox_item_id?: string | null
  supplier_invoice_id?: string | null
  voucher: string | null
  entry_status: string | null
  entry_date: string
  amount_sek: number
  committed_at: string | null
  reviewed_at: string | null
}

export type RevokeGrantResult =
  | {
      ok: true
      data: {
        grant_id: string
        version: number
        /** The operation the rule covered; categorize_transaction before migration 20261018100200. */
        operation_type: string
        counterparty_label: string
        /** False when the grant was already revoked: nothing was written. */
        changed: boolean
        revoked_at: string | null
        /** Every posting the grant let through (at most 500 listed), newest first. */
        postings: RevokedPosting[]
        postings_count: number
      }
    }
  | GrantCommitFailure

interface RpcResult {
  ok: boolean
  code?: string
  [key: string]: unknown
}

function refusal(code: string, fallbackStatus: number): GrantCommitFailure {
  const entry = getErrorEntry(code)
  return { ok: false, code, message_sv: entry?.message_sv ?? code, status: entry?.httpStatus ?? fallbackStatus }
}

function credentialArgs(credential: CreateGrantParams['credential']): { scope: string; id: string | null } {
  switch (credential.kind) {
    case 'api_key':
      return { scope: 'api_key', id: credential.api_key_id }
    case 'service_account':
      return { scope: 'service_account', id: credential.service_account_id }
    default:
      return { scope: 'any', id: null }
  }
}

/**
 * The create_company_grant arguments for a rule. A bank-line rule sends the
 * slice 1 argument set exactly (that overload works before and after
 * migration 20261018100100); a supplier-invoice rule sends the two more the
 * new overload takes, the supplier and the line bookings, with no category
 * and no business account.
 */
export function createGrantArgs(input: GrantDecisionInput & { params: CreateGrantParams }): Record<string, unknown> {
  const { params } = input
  const credential = credentialArgs(params.credential)
  const shared = {
    p_company_id: input.companyId,
    p_decided_by: input.userId,
    p_actor_type: input.actor.type,
    p_actor_label: input.actor.label ?? null,
    p_pending_operation_id: input.pendingOperationId,
    p_operation_type: params.operation_type,
    p_counterparty_label: params.counterparty_label,
    p_amount_limit_sek: params.amount_limit_sek,
    p_monthly_limit_sek: params.monthly_limit_sek ?? null,
    p_credential_scope: credential.scope,
    p_credential_id: credential.id,
    p_evidence: params.evidence ?? {},
  }
  if (params.operation_type === 'create_supplier_invoice_from_inbox') {
    return {
      ...shared,
      p_counterparty_key: `supplier:${params.supplier_id}`,
      p_direction: 'out',
      p_category: null,
      p_vat_treatment: params.pattern.vat_treatment,
      p_reverse_charge_kind: params.pattern.reverse_charge_kind,
      p_account_number: null,
      p_line_accounts: params.pattern.line_accounts,
      p_supplier_id: params.supplier_id,
      p_item_lines: params.pattern.item_lines,
    }
  }
  return {
    ...shared,
    p_counterparty_key: params.counterparty_key,
    p_direction: params.pattern.direction,
    p_category: params.pattern.category,
    p_vat_treatment: params.pattern.vat_treatment,
    p_reverse_charge_kind: params.pattern.reverse_charge_kind,
    p_account_number: params.pattern.account_number,
    p_line_accounts: params.pattern.line_accounts,
  }
}

export async function createGrantFromOperation(
  serviceClient: SupabaseClient,
  input: GrantDecisionInput & { params: CreateGrantParams },
): Promise<CreateGrantResult> {
  const { params } = input
  const { data, error } = await serviceClient.rpc('create_company_grant', createGrantArgs(input))
  if (error) throw new Error(`Failed to create the grant: ${error.message}`)
  const result = (data ?? {}) as RpcResult
  if (!result.ok) return refusal(result.code ?? 'GRANT_INVALID', 400)
  return {
    ok: true,
    data: {
      grant_id: String(result.grant_id),
      version: Number(result.version),
      superseded_grant_id: typeof result.superseded_grant_id === 'string' ? result.superseded_grant_id : null,
      counterparty_label: params.counterparty_label,
      amount_limit_sek: params.amount_limit_sek,
      valid_from: typeof result.valid_from === 'string' ? result.valid_from : null,
    },
  }
}

export async function revokeGrantFromOperation(
  serviceClient: SupabaseClient,
  input: GrantDecisionInput & { params: RevokeGrantParams },
): Promise<RevokeGrantResult> {
  const { data, error } = await serviceClient.rpc('revoke_company_grant', {
    p_company_id: input.companyId,
    p_grant_id: input.params.grant_id,
    p_decided_by: input.userId,
    p_actor_type: input.actor.type,
    p_actor_label: input.actor.label ?? null,
    p_pending_operation_id: input.pendingOperationId,
  })
  if (error) throw new Error(`Failed to revoke the grant: ${error.message}`)
  const result = (data ?? {}) as RpcResult
  if (!result.ok) return refusal(result.code ?? 'GRANT_NOT_FOUND', 404)
  const postings = Array.isArray(result.postings) ? (result.postings as RevokedPosting[]) : []
  return {
    ok: true,
    data: {
      grant_id: String(result.grant_id),
      version: Number(result.version),
      operation_type: typeof result.operation_type === 'string' ? result.operation_type : 'categorize_transaction',
      counterparty_label: String(result.counterparty_label ?? ''),
      changed: result.unchanged !== true,
      revoked_at: typeof result.revoked_at === 'string' ? result.revoked_at : null,
      postings,
      postings_count: typeof result.postings_count === 'number' ? result.postings_count : postings.length,
    },
  }
}
