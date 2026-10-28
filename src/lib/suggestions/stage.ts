/**
 * Stage a detector's proposal: one pending operation as the system, through
 * stage_company_suggestion (migration 20261016200600), which skips a key
 * that is open, snoozed ("Inte nu") or declined ("Visa aldrig") and stages
 * it once when two events race.
 *
 * Never throws and never fails its caller: a detector runs inside the event
 * consumer and the daily cron, where a suggestion that could not be staged
 * must not break the write that woke it. Deploy order: the code can reach a
 * database before the migrations that know the operation types, the actor
 * type or the function do. The database then refuses (check_violation on the
 * operation or actor type, an unknown function or table) and this logs and
 * skips: the suggestion is simply made on a later event.
 */
import { stagedRiskLevel } from '@/lib/pending-operations/stage'
import { assertNoPlaintextPersonnummer } from '@/lib/pending-operations/staging-pii-guard'
import type { DetectorContext, SuggestionProposal } from './types'
import { toError } from '@/lib/errors/to-error'

export type StageOutcome =
  | { staged: true; suggestionId: string; pendingOperationId: string }
  | { staged: false; reason: 'open' | 'snoozed' | 'declined' | 'not_in_database' | 'failed' }

/**
 * Codes that mean "this database does not have the suggestion machinery
 * yet": the CHECK refusing an operation or actor type it does not list
 * (23514), a function or table it does not have (42883, 42P01), or
 * PostgREST not knowing the function (PGRST202).
 */
const NOT_IN_DATABASE_CODES: ReadonlySet<string> = new Set(['23514', '42883', '42P01', 'PGRST202'])

export function isNotInDatabase(error: { code?: string | null } | null | undefined): boolean {
  return !!error?.code && NOT_IN_DATABASE_CODES.has(error.code)
}

interface StageRpcResult {
  staged: boolean
  reason?: string
  suggestion_id?: string
  pending_operation_id?: string
}

export async function stageSuggestion(
  ctx: DetectorContext,
  detectorId: string,
  proposal: SuggestionProposal,
): Promise<StageOutcome> {
  const previewData = { ...(proposal.preview ?? {}), reason: proposal.reason }
  try {
    // The same guard every staging door runs: a suggestion never carries a
    // plaintext personnummer (the proposals here carry ids and names only).
    assertNoPlaintextPersonnummer(proposal.params, 'params')
    assertNoPlaintextPersonnummer(previewData, 'preview_data')

    const { data, error } = await ctx.supabase.rpc('stage_company_suggestion', {
      p_company_id: ctx.companyId,
      p_user_id: ctx.userId,
      p_suggestion_key: proposal.key,
      p_detector: detectorId,
      p_rank: proposal.rank,
      p_operation_type: proposal.operationType,
      p_title: proposal.title,
      p_params: proposal.params,
      p_preview_data: previewData,
      p_risk_level: stagedRiskLevel(proposal.operationType, proposal.params),
    })
    if (error) {
      if (isNotInDatabase(error)) {
        ctx.log.warn('suggestion skipped: the database does not have the suggestion operation yet (deploy order)', {
          companyId: ctx.companyId,
          detector: detectorId,
          key: proposal.key,
          code: error.code,
        })
        return { staged: false, reason: 'not_in_database' }
      }
      ctx.log.error('suggestion could not be staged', new Error(error.message), {
        companyId: ctx.companyId,
        detector: detectorId,
        key: proposal.key,
        code: error.code,
      })
      return { staged: false, reason: 'failed' }
    }
    const result = (data ?? {}) as StageRpcResult
    if (result.staged && result.suggestion_id && result.pending_operation_id) {
      ctx.log.info('suggestion staged', { companyId: ctx.companyId, detector: detectorId, key: proposal.key })
      return { staged: true, suggestionId: result.suggestion_id, pendingOperationId: result.pending_operation_id }
    }
    const reason = result.reason === 'open' || result.reason === 'snoozed' || result.reason === 'declined' ? result.reason : 'failed'
    return { staged: false, reason }
  } catch (err) {
    ctx.log.error('suggestion could not be staged', toError(err), {
      companyId: ctx.companyId,
      detector: detectorId,
      key: proposal.key,
    })
    return { staged: false, reason: 'failed' }
  }
}
