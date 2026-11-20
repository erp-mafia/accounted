import { requireCompanyAdmin } from '@/lib/operations/access'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import type { ContinuityDiscrepancy } from '@/types'

/**
 * Confirming the opening balance review an SIE import raises on the year
 * after the one it changed (fiscal_periods.opening_balance_review_*, set by
 * flag_sie_next_period_review): the year's ingående balanser were not changed
 * automatically, and someone confirms they still hold. The confirmation is
 * metadata: acknowledge_sie_opening_balance_review clears the review and
 * records who and when in audit_log; no verifikat changes.
 *
 * One definition for every door: the review dialog's route
 * (/api/bookkeeping/fiscal-periods/[id]/opening-balance-review) and the
 * staged operation imports.opening-balance-review.acknowledge (MCP).
 *
 * Like the dialog, the confirmation does not require the IB to equal the
 * year before's UB. The dry run compares them per balance-sheet account with
 * validateBalanceContinuity (the one IB/UB check, also the year-end's and
 * GET /reports/continuity-check's) so the agent and the approver see every
 * difference before the approval.
 */

export interface OpeningBalanceReviewInput {
  fiscal_period_id: string
  /** The review the caller saw. Undefined takes the year's open review. */
  review_token?: string
  /** The IB verifikat the caller reviewed (null: the year has none). Undefined takes the year's current one. */
  opening_balance_entry_id?: string | null
}

export interface OpeningBalanceReviewPreview {
  fiscal_period_id: string
  period_name: string
  review_token: string
  opening_balance_entry_id: string | null
  /** 'import': a completed import of the year before; 'undo': its undo. */
  review_reason: 'import' | 'undo' | null
  sie_import_id: string | null
  previous_period_name: string | null
  ib_matches_previous_ub: boolean
  checked_accounts: number
  discrepancies: ContinuityDiscrepancy[]
}

export interface OpeningBalanceReviewResult {
  fiscal_period_id: string
  period_name: string
  reviewed: true
}

interface ReviewPeriodRow {
  id: string
  name: string
  opening_balance_entry_id: string | null
  opening_balance_review_token: string | null
  opening_balance_review_reason: 'import' | 'undo' | null
  opening_balance_review_import_id: string | null
}

const ADMIN_MESSAGE_SV = 'Endast ägare och administratörer kan bekräfta granskningen.'
const ADMIN_MESSAGE_EN = 'Only owners and administrators can confirm the review.'

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

/**
 * The refusals of acknowledge_sie_opening_balance_review (20260911165308):
 * 42501 not owner or admin, P0002 no such year in the company, 55000 an
 * import still running or a review that changed since it was read. Anything
 * else is not a refusal and is thrown for the door to classify.
 */
function rpcRefusal(error: { code?: string; message?: string }, fiscalPeriodId: string): Refusal | null {
  if (error.code === '42501') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      messageSv: ADMIN_MESSAGE_SV,
      messageEn: ADMIN_MESSAGE_EN,
      details: { required_roles: ['owner', 'admin'] },
    }
  }
  if (error.code === 'P0002') return { ok: false, code: 'OB_PERIOD_NOT_FOUND', details: { fiscal_period_id: fiscalPeriodId } }
  if (error.code === '55000' && /unfinished/i.test(error.message ?? '')) {
    return { ok: false, code: 'OB_REVIEW_IMPORT_RUNNING', details: { fiscal_period_id: fiscalPeriodId } }
  }
  if (error.code === '55000' || error.code === '40001' || error.code === '55P03') {
    return { ok: false, code: 'OB_REVIEW_CHANGED', details: { fiscal_period_id: fiscalPeriodId } }
  }
  return null
}

/**
 * Confirm the year's open review, or on a dry run preview it: the review it
 * would clear and how the year's IB compares with the year before's UB.
 * A review_token or opening_balance_entry_id that no longer matches the year
 * is refused as OB_REVIEW_CHANGED, so a commit holds to what was reviewed.
 */
export async function acknowledgeOpeningBalanceReview(
  ctx: OperationContext,
  input: OpeningBalanceReviewInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<OpeningBalanceReviewResult>> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select(
      'id, name, opening_balance_entry_id, opening_balance_review_token, opening_balance_review_reason, opening_balance_review_import_id',
    )
    .eq('id', input.fiscal_period_id)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) throw error
  const period = data as ReviewPeriodRow | null
  if (!period) return { ok: false, code: 'OB_PERIOD_NOT_FOUND', details: { fiscal_period_id: input.fiscal_period_id } }

  const reviewToken = period.opening_balance_review_token
  if (!reviewToken) {
    return { ok: false, code: 'OB_REVIEW_NOT_PENDING', details: { fiscal_period_id: period.id, period_name: period.name } }
  }
  const tokenMoved = input.review_token !== undefined && input.review_token !== reviewToken
  const entryMoved =
    input.opening_balance_entry_id !== undefined && input.opening_balance_entry_id !== period.opening_balance_entry_id
  if (tokenMoved || entryMoved) {
    return { ok: false, code: 'OB_REVIEW_CHANGED', details: { fiscal_period_id: period.id, period_name: period.name } }
  }

  if (options.dryRun) {
    // The RPC refuses a member at the commit; the preview refuses first, so
    // an agent's proposal that could never be approved is not staged.
    const denied = await requireCompanyAdmin(ctx, ADMIN_MESSAGE_SV)
    if (denied) return { ...denied, messageEn: ADMIN_MESSAGE_EN }
    const continuity = await validateBalanceContinuity(ctx.supabase, ctx.companyId, period.id)
    const preview: OpeningBalanceReviewPreview = {
      fiscal_period_id: period.id,
      period_name: period.name,
      review_token: reviewToken,
      opening_balance_entry_id: period.opening_balance_entry_id,
      review_reason: period.opening_balance_review_reason,
      sie_import_id: period.opening_balance_review_import_id,
      previous_period_name: continuity.previous_period_name,
      ib_matches_previous_ub: continuity.valid,
      checked_accounts: continuity.checked_accounts,
      discrepancies: continuity.discrepancies,
    }
    return { ok: true, dryRun: true, preview: { ...preview } }
  }

  const { error: rpcError } = await ctx.supabase.rpc('acknowledge_sie_opening_balance_review', {
    p_company_id: ctx.companyId,
    p_period_id: period.id,
    p_actor: ctx.userId,
    p_review_token: reviewToken,
    p_expected_entry_id: period.opening_balance_entry_id,
  })
  if (rpcError) {
    const refusal = rpcRefusal(rpcError, period.id)
    if (refusal) return refusal
    throw rpcError
  }
  return { ok: true, data: { fiscal_period_id: period.id, period_name: period.name, reviewed: true } }
}
