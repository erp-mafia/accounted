import type { SupabaseClient } from '@supabase/supabase-js'
import { rpcClientForBulkDelete } from '@/lib/import/sie-import'
import type { FiscalYearResetEligibility, FiscalYearResetRpcResult } from '@/types'

/**
 * Fiscal-year reset (issue #1883): guarded hard-delete of ALL vouchers in one
 * OPEN fiscal year, regardless of how they arrived (SIE import, manual,
 * agent). The heavy lifting and every guard live in the `reset_fiscal_year`
 * RPC (migration 20260825150000), which reuses the same
 * `gnubok.allow_delete` escape hatch as `undo_sie_import`: this module is a
 * thin typed wrapper.
 *
 * The RPC refuses whenever any reliance state exists: locked/closed year,
 * company lock date over the year, year-end/arsredovisning state, a later
 * year depending on this year's UB, VAT/AGI declared evidence, or entries
 * referenced by other records (assets, accruals, salary runs). Documents are
 * detached, never deleted (BFL 7 kap).
 */

export type FiscalYearResetOutcome =
  | { ok: true; deleted: number; detachedDocuments: number; periodName: string }
  | { ok: false; code: string; blockers?: FiscalYearResetEligibility['blockers'] }

export type FiscalYearResetEligibilityOutcome =
  | { ok: true; eligibility: FiscalYearResetEligibility }
  | { ok: false; code: string }

/**
 * Owner/admin-only eligibility preview. Runs on the caller's session client
 * (auth.uid() present), so no explicit user id is needed. The execution RPC
 * rechecks every condition; this response is informational only.
 */
export async function getFiscalYearResetEligibility(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<FiscalYearResetEligibilityOutcome> {
  const { data, error } = await supabase.rpc('get_fiscal_year_reset_eligibility', {
    p_company_id: companyId,
    p_period_id: periodId,
  })

  if (error) {
    return { ok: false, code: 'FISCAL_YEAR_RESET_FAILED' }
  }

  const result = data as FiscalYearResetRpcResult | null
  if (!result?.ok) {
    return { ok: false, code: result?.code ?? 'FISCAL_YEAR_RESET_FAILED' }
  }

  return {
    ok: true,
    eligibility: {
      eligible: result.eligible === true,
      blockers: result.blockers ?? [],
      period: result.period!,
      counts: result.counts ?? { vouchers: 0, documents_to_detach: 0 },
      next_period: result.next_period ?? null,
    },
  }
}

/**
 * Execute the reset. Runs on the service client when available (the
 * authenticated role's 8s statement_timeout cannot fit a year-sized delete;
 * see rpcClientForBulkDelete), passing the authorising user explicitly: on
 * the service client auth.uid() is NULL and the RPC resolves its owner/admin
 * gate from p_user_id instead. `confirmedName` must restate the year's label
 * exactly (typed confirmation, verified again inside the RPC).
 */
export async function resetFiscalYear(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  userId: string,
  confirmedName: string,
): Promise<FiscalYearResetOutcome> {
  const rpcClient = await rpcClientForBulkDelete(supabase)
  const { data, error } = await rpcClient.rpc('reset_fiscal_year', {
    p_company_id: companyId,
    p_period_id: periodId,
    p_confirmed_name: confirmedName,
    p_user_id: userId,
  })

  if (error) {
    return { ok: false, code: 'FISCAL_YEAR_RESET_FAILED' }
  }

  const result = data as FiscalYearResetRpcResult | null
  if (!result?.ok) {
    return {
      ok: false,
      code: result?.code ?? 'FISCAL_YEAR_RESET_FAILED',
      blockers: result?.blockers,
    }
  }

  return {
    ok: true,
    deleted: result.deleted ?? 0,
    detachedDocuments: result.detached_documents ?? 0,
    periodName: result.period_name ?? '',
  }
}
