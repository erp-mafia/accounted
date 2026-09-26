import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceCorrectSchema } from '@/lib/api/schemas'
import { correctOpeningBalances } from '@/lib/import/opening-balance/service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

/**
 * POST /api/import/opening-balance/correct
 *
 * Correct a period's existing opening balances the BFL-compliant way: the
 * current IB verifikat (immutable, posted) is stornoed and a corrected IB is
 * booked, then fiscal_periods.opening_balance_entry_id is relinked to the new
 * entry via the replace_period_opening_balance_link RPC.
 *
 * Because getOpeningBalances reads the linked entry directly and the
 * trial-balance / general-ledger movement queries include both `posted` and
 * `reversed` lines (excluding only the linked OB entry), the stornoed old IB
 * and its storno mirror cancel out in period movement, so the Balansrapport
 * IB column shows the corrected figures and UB stays correct.
 *
 * Gated to the safe case only: the period must be open, unlocked, already have
 * opening balances, and have no year-end close on top. Locked/closed periods or
 * periods with a bokslut must be unwound first (assisted): we refuse here.
 *
 * With `cascade: true` the same per-account delta is then applied to every
 * subsequent year's linked IB verifikat (storno + rebook + relink per year;
 * see lib/import/opening-balance/cascade.ts). Uncorrectable years are
 * skipped and reported in the response, never forced.
 *
 * The rules live in lib/import/opening-balance/service.ts, shared with the
 * v1 operation opening-balances.correct.
 */
export const POST = withRouteContext(
  'opening_balance.correct',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, OpeningBalanceCorrectSchema, {
      log,
      operation: 'opening_balance.correct',
    })
    if (!result.success) return result.response

    const { fiscal_period_id, lines, cascade } = result.data
    const opLog = log.child({ fiscalPeriodId: fiscal_period_id })

    // Write-role (non-viewer) + company membership are enforced by
    // withRouteContext({ requireWrite: true }); the service scopes every read
    // by that verified companyId.
    const outcome = await correctOpeningBalances(
      { supabase, companyId: companyId!, userId: user.id, log: opLog },
      { fiscal_period_id, lines, cascade },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')

    const { data } = outcome
    return NextResponse.json({
      data: {
        success: true,
        journal_entry_id: data.journal_entry_id,
        reversed_entry_id: data.reversed_entry_id,
        fiscal_period_id: data.fiscal_period_id,
        lines_created: data.lines_created,
        total_debit: data.total_debit,
        total_credit: data.total_credit,
        ...(data.cascade ? { cascade: data.cascade } : {}),
      },
    })
  },
  { requireWrite: true },
)
