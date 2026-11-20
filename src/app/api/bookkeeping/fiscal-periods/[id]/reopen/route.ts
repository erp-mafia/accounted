import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { FiscalYearReopenSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  FISCAL_YEAR_REOPEN_REGISTRY_KEYS,
  getFiscalYearReopenEligibility,
  reopenClosedFiscalYear,
  type FiscalYearReopenDeps,
} from '@/lib/core/bookkeeping/fiscal-year-reopen'
import { ensureTicSnapshot } from '@/lib/agent/composer/tic-fetch'
import { linkBasisColumns } from '@/lib/links/stamp'
import type { SupabaseClient } from '@supabase/supabase-js'

type Params = { params: Promise<{ id: string }> }

/**
 * Bolagsverket, as the gate reads it: the TIC snapshot, re-fetched when it is
 * older than 7 days or lacks the keys the gate needs. The owner is waiting on
 * the dialog, so the Lens fan-out gets 10 s.
 */
function registryDeps(supabase: SupabaseClient, companyId: string): FiscalYearReopenDeps {
  return {
    refreshRegistry: () =>
      ensureTicSnapshot({
        supabase,
        companyId,
        timeoutMs: 10_000,
        requireKeys: FISCAL_YEAR_REOPEN_REGISTRY_KEYS,
        purpose: 'refresh',
      }),
  }
}

/**
 * GET /api/bookkeeping/fiscal-periods/[id]/reopen
 *
 * Owner-only preview for reopening a year closed with a bokslut in Accounted
 * (crm#1290): the gates that refuse it, the verifikat the reopen reverses by
 * storno and the unsigned årsredovisning it supersedes. The reopen checks
 * every gate again, so this is informational only.
 */
export const GET = withRouteContext<Params>(
  'period.reopen.preview',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ periodId: id })

    const result = await getFiscalYearReopenEligibility(supabase, companyId!, id, registryDeps(supabase, companyId!))
    if (!result.ok) return errorResponseFromCode(result.code, opLog, { requestId })
    return NextResponse.json({ data: result.eligibility })
  },
)

/**
 * POST /api/bookkeeping/fiscal-periods/[id]/reopen
 *
 * Reopens the year: the database gate and state change, then the engine's
 * stornos of the bokslut and the detach of the closing entry. Session only,
 * like the fiscal-year reset: an owner's typed statement about the
 * årsredovisning is not something an API key or an agent gives.
 */
export const POST = withRouteContext<Params>(
  'period.reopen.execute',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ periodId: id })

    const validation = await validateBody(request, FiscalYearReopenSchema, {
      log: opLog,
      operation: 'period.reopen.execute',
    })
    if (!validation.success) return validation.response

    const result = await reopenClosedFiscalYear(
      supabase,
      companyId!,
      id,
      user.id,
      {
        confirmName: validation.data.confirm_name,
        confirmNotAdopted: validation.data.confirm_annual_report_not_adopted,
      },
      {
        ...registryDeps(supabase, companyId!),
        // The posting port's events, while POSTING_EVENTS is on: the owner reopened the year.
        posting: () => ({ linkBasis: linkBasisColumns('user_created') }),
      },
    )

    if (!result.ok) {
      if (result.stoppedAt) opLog.warn('fiscal year reopen incomplete', { stoppedAt: result.stoppedAt })
      return errorResponseFromCode(result.code, opLog, {
        requestId,
        details: result.blockers ? { blockers: result.blockers } : undefined,
      })
    }

    opLog.info('fiscal year reopened by owner', {
      resumed: result.resumed,
      reversed: result.reversed.length,
      supersededVersions: result.supersededVersions,
    })
    return NextResponse.json({
      data: {
        periodName: result.periodName,
        resumed: result.resumed,
        reversed: result.reversed.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          voucher: formatVoucher(entry),
        })),
        supersededVersions: result.supersededVersions,
      },
    })
  },
  { requireWrite: true },
)
