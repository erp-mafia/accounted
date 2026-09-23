import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { FiscalYearResetSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  getFiscalYearResetEligibility,
  resetFiscalYear,
} from '@/lib/core/bookkeeping/fiscal-year-reset'

type Params = { params: Promise<{ id: string }> }

// Hard-deleting a year of audit-logged journal entries (+ cascading lines)
// can take well over the default function timeout. Match the SIE undo route
// so the serverless function doesn't kill the request first.
export const maxDuration = 300

const EXPECTED_CODES = new Set([
  'FISCAL_YEAR_RESET_NOT_FOUND',
  'FISCAL_YEAR_RESET_FORBIDDEN',
  'FISCAL_YEAR_RESET_INELIGIBLE',
  'FISCAL_YEAR_RESET_CONFIRMATION_MISMATCH',
  'FISCAL_YEAR_RESET_LINKED_ENTRIES',
])

function knownCode(code: string): string {
  return EXPECTED_CODES.has(code) ? code : 'FISCAL_YEAR_RESET_FAILED'
}

/**
 * GET /api/bookkeeping/fiscal-periods/[id]/reset
 *
 * Owner/admin-only, fail-closed eligibility preview for the fiscal-year
 * reset: which guards block it, and what a reset would delete (voucher
 * count) and detach (document links; the documents themselves are never
 * deleted, BFL 7 kap). The execution RPC rechecks every condition, so this
 * response is informational only.
 */
export const GET = withRouteContext<Params>(
  'period.reset.preview',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ periodId: id })

    const result = await getFiscalYearResetEligibility(supabase, companyId!, id)
    if (!result.ok) {
      return errorResponseFromCode(knownCode(result.code), opLog, { requestId })
    }

    return NextResponse.json({ data: result.eligibility })
  },
)

/**
 * POST /api/bookkeeping/fiscal-periods/[id]/reset
 *
 * Executes the reset: hard-deletes ALL vouchers in the open fiscal year.
 * Requires the year's label restated as typed confirmation (confirm_name);
 * refused past any lock/close/declared/year-end/next-year-dependency state.
 * All guards are enforced inside the reset_fiscal_year RPC.
 */
export const POST = withRouteContext<Params>(
  'period.reset.execute',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ periodId: id })

    const validation = await validateBody(request, FiscalYearResetSchema, {
      log: opLog,
      operation: 'period.reset.execute',
    })
    if (!validation.success) return validation.response

    const result = await resetFiscalYear(
      supabase,
      companyId!,
      id,
      user.id,
      validation.data.confirm_name,
    )

    if (!result.ok) {
      return errorResponseFromCode(knownCode(result.code), opLog, {
        requestId,
        details: result.blockers ? { blockers: result.blockers } : undefined,
      })
    }

    opLog.info('fiscal year reset executed', {
      deleted: result.deleted,
      detachedDocuments: result.detachedDocuments,
    })

    return NextResponse.json({
      data: {
        deleted: result.deleted,
        detachedDocuments: result.detachedDocuments,
        periodName: result.periodName,
      },
    })
  },
  { requireWrite: true },
)
