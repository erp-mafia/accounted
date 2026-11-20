import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { listLedgerDividendPayouts, recordLedgerDividend } from '@/lib/bolaget/capital/dividends'
import { LedgerDividendBody } from '@/lib/bolaget/capital/schemas'

function readYear(request: Request): number | null {
  const raw = new URL(request.url).searchParams.get('year')
  const year = raw ? Number(raw) : NaN
  return Number.isInteger(year) && year >= 2000 && year <= 2099 ? year : null
}

/**
 * GET /api/bolaget/capital/dividends/ledger?year=: the dividend payouts of a
 * year already in the ledger (posted verifikat debiting 2898) that no
 * dividend in the register points at: where the one-time "who received"
 * step starts for a dividend paid before the aktiebok existed.
 */
export const GET = withRouteContext('bolaget.dividend_ledger_list', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const year = readYear(request)
  if (year === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  return NextResponse.json({ data: { payouts: await listLedgerDividendPayouts(ctx.supabase, ctx.companyId, year) } })
})

/**
 * POST /api/bolaget/capital/dividends/ledger: record who received a
 * dividend the ledger already holds (?dry_run=true previews). Books
 * nothing. App only: the recipients' personnummer are completed in the
 * person form.
 */
export const POST = withRouteContext(
  'bolaget.dividend_ledger_record',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, LedgerDividendBody)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await recordLedgerDividend(operationContext(ctx), validation.data, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
