/**
 * Defense-in-depth ownership check for caller-supplied `fiscal_period_id`
 * inputs. Every v1 endpoint that accepts a fiscal_period_id in the request
 * body / query string must call this BEFORE handing the id to the engine.
 *
 * Why this exists:
 *   - The engine functions all scope by company_id internally
 *     (`createDraftEntry`, `generateOpeningBalances`, etc), so there is no
 *     literal cross-tenant data leak today.
 *   - But the engine throws Swedish error strings on mismatch
 *     ("Fiscal period not found"), and the route layer would otherwise have
 *     to scrape that string to produce a structured error envelope.
 *   - More importantly, an INSERT that takes both `company_id` (from URL)
 *     and `fiscal_period_id` (from body) without verifying they belong
 *     together creates a broken-link state: the row persists with a
 *     pointer at another company's period. Downstream queries return
 *     garbage even though no data was leaked. See:
 *     - voucher_gap_explanations: detect_voucher_gaps would never match.
 *     - journal_entries: balance triggers fire against the wrong period.
 *
 * Use everywhere a `fiscal_period_id` enters the system from the caller.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Returns true when (fiscal_period_id, company_id) is a real pairing in the
 * `fiscal_periods` table. Cheap point lookup; the caller maps `false` to a
 * structured NOT_FOUND or VALIDATION_ERROR envelope as appropriate.
 *
 * Cross-period checks that need additional state (is_closed, locked_at)
 * should still go through `checkPeriodLock`; this helper only answers the
 * ownership question.
 */
export async function ownsFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  return !!data
}
