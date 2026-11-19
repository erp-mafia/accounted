/**
 * What a person does with grants in the app, behind the Att göra section
 * "Bokfört enligt regel" (src/app/api/grants/*):
 *
 *   - stageGrantRevocation: stage revoke_grant for a grant. Revoking is a
 *     staged operation like creating one, so it has a receipt, an audit row
 *     and a dated line in behandlingshistorik; the app then approves it
 *     through the commit door every staged operation has, where
 *     revoke_company_grant re-checks that the approver is an owner or admin
 *     (otherwise it waits in /pending for one who is).
 *   - markGrantPostingsReviewed: the postings shown were looked at.
 *   - setGrantsPaused: the company's kill switch, effective at once.
 *
 * The undo of a posting is not here: it is the bank line's own Ångra (POST
 * /api/transactions/{id}/uncategorize), a storno through the engine, never a
 * delete.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { insertStagedOperation } from '@/lib/pending-operations/stage'
import type { RevokeGrantParams } from './types'

export type GrantActionFailure = { ok: false; code: string; status: number }

interface GrantRow {
  id: string
  version: number
  counterparty_label: string
  amount_limit_sek: number | string
  revoked_at: string | null
}

/**
 * Stage revoke_grant. `serviceClient` writes the staged row (a session may
 * only insert agent_chat operations); the grant is read with the caller's
 * session client, so RLS decides which grants they see.
 */
export async function stageGrantRevocation(
  supabase: SupabaseClient,
  serviceClient: SupabaseClient,
  input: { companyId: string; userId: string; userLabel?: string | null; grantId: string },
  log: Logger,
): Promise<{ ok: true; operationId: string } | GrantActionFailure> {
  const { data, error } = await supabase
    .from('company_grants')
    .select('id, version, counterparty_label, amount_limit_sek, revoked_at')
    .eq('id', input.grantId)
    .eq('company_id', input.companyId)
    .maybeSingle()
  if (error && error.code !== '22P02') throw new Error(`Failed to read the grant: ${error.message}`)
  const grant = (data as GrantRow | null) ?? null
  if (!grant) return { ok: false, code: 'GRANT_NOT_FOUND', status: 404 }
  if (grant.revoked_at) return { ok: false, code: 'GRANT_ALREADY_REVOKED', status: 409 }

  const params: RevokeGrantParams = { grant_id: grant.id, counterparty_label: grant.counterparty_label }
  const { row } = await insertStagedOperation(
    serviceClient,
    {
      companyId: input.companyId,
      userId: input.userId,
      operationType: 'revoke_grant',
      title: `Återkalla regel för automatisk bokföring: ${grant.counterparty_label}`,
      params: params as unknown as Record<string, unknown>,
      previewData: {
        counterparty: grant.counterparty_label,
        version: grant.version,
        amount_limit_sek: Number(grant.amount_limit_sek),
      },
      actor: { type: 'user', label: input.userLabel ?? null },
    },
    log,
  )
  return { ok: true, operationId: row.id }
}

export async function markGrantPostingsReviewed(
  supabase: SupabaseClient,
  companyId: string,
  useIds: string[],
): Promise<{ ok: true; reviewed: number } | GrantActionFailure> {
  const { data, error } = await supabase.rpc('mark_company_grant_uses_reviewed', {
    p_company_id: companyId,
    p_use_ids: useIds,
  })
  if (error) throw new Error(`Failed to mark the postings reviewed: ${error.message}`)
  const result = (data ?? {}) as { ok?: boolean; code?: string; reviewed?: number }
  if (!result.ok) return { ok: false, code: result.code ?? 'GRANT_REVIEW_FORBIDDEN', status: result.code === 'GRANT_INVALID' ? 400 : 403 }
  return { ok: true, reviewed: Number(result.reviewed ?? 0) }
}

export async function setGrantsPaused(
  supabase: SupabaseClient,
  companyId: string,
  paused: boolean,
): Promise<{ ok: true; paused: boolean; changed: boolean } | GrantActionFailure> {
  const { data, error } = await supabase.rpc('set_company_grants_paused', { p_company_id: companyId, p_paused: paused })
  if (error) throw new Error(`Failed to switch the rules: ${error.message}`)
  const result = (data ?? {}) as { ok?: boolean; code?: string; unchanged?: boolean }
  if (!result.ok) return { ok: false, code: result.code ?? 'GRANT_ADMIN_REQUIRED', status: 403 }
  return { ok: true, paused, changed: result.unchanged !== true }
}
