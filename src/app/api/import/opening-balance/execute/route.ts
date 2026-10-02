import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { OpeningBalanceExecuteSchema } from '@/lib/api/schemas'
import { setOpeningBalances } from '@/lib/import/opening-balance/service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

/**
 * POST /api/import/opening-balance/execute
 *
 * Creates an opening balance journal entry from user-confirmed lines and
 * auto-activates BAS accounts not yet in the company's chart. The rules live
 * in lib/import/opening-balance/service.ts, shared with the v1 operation
 * opening-balances.set-manual.
 */
export const POST = withRouteContext(
  'opening_balance.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const result = await validateBody(request, OpeningBalanceExecuteSchema, {
      log,
      operation: 'opening_balance.execute',
    })
    if (!result.success) return result.response

    const { fiscal_period_id, lines } = result.data
    const opLog = log.child({ fiscalPeriodId: fiscal_period_id })

    const outcome = await setOpeningBalances(
      { supabase, companyId: companyId!, userId: user.id, log: opLog },
      { fiscal_period_id, lines, description: 'Ingående balanser (Excel-import)' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')

    const { data } = outcome
    return NextResponse.json({
      data: {
        success: true,
        journal_entry_id: data.journal_entry_id,
        fiscal_period_id: data.fiscal_period_id,
        lines_created: data.lines_created,
        total_debit: data.total_debit,
        total_credit: data.total_credit,
      },
    })
  },
  { requireWrite: true },
)
