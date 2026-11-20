import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { contractRevenueEnabled } from '@/lib/env/contract-revenue-switch'
import {
  ContractRevenueError,
  deleteContractRevenueSettings,
  getContractRevenueSettings,
  listContracts,
  saveContractRevenueSettings,
} from '@/lib/bokslut/pagaende-arbeten/register'
import { ContractRevenueSettingsSchema } from '@/lib/bokslut/pagaende-arbeten/schemas'

/**
 * GET /api/bookkeeping/contract-revenue: the company's method and adjustment
 * account for pågående arbeten (K3 kapitel 23) and its uppdrag. Behind
 * NEXT_PUBLIC_CONTRACT_REVENUE_ENABLED.
 */
export const GET = withRouteContext('bookkeeping.contract-revenue.get', async (_request, ctx) => {
  if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
  const [settings, contracts] = await Promise.all([
    getContractRevenueSettings(ctx.supabase, ctx.companyId),
    listContracts(ctx.supabase, ctx.companyId),
  ])
  return NextResponse.json({ data: { settings, contracts } })
})

/**
 * PUT /api/bookkeeping/contract-revenue: choose the method and the class 3
 * account the year's adjustment is booked on. The account is pinned outside
 * the momsdeklaration (momssats 0, no momskod); one that a ruta reads, or one
 * with posted lines for something else, is refused.
 */
export const PUT = withRouteContext(
  'bookkeeping.contract-revenue.settings',
  async (request, ctx) => {
    if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, ContractRevenueSettingsSchema, {
      log: ctx.log,
      operation: 'bookkeeping.contract-revenue.settings',
    })
    if (!body.success) return body.response
    try {
      const settings = await saveContractRevenueSettings(ctx.supabase, ctx.companyId, ctx.user.id, body.data)
      return NextResponse.json({ data: settings })
    } catch (err) {
      if (err instanceof ContractRevenueError) {
        return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId, details: err.details })
      }
      throw err
    }
  },
  { requireWrite: true },
)

/**
 * DELETE /api/bookkeeping/contract-revenue: stop using pågående arbeten. The
 * method and account go; the uppdrag stay. The account is released unless
 * a booked year took the adjustment on it, which keeps it outside the
 * momsdeklaration.
 */
export const DELETE = withRouteContext(
  'bookkeeping.contract-revenue.settings.delete',
  async (_request, ctx) => {
    if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
    try {
      await deleteContractRevenueSettings(ctx.supabase, ctx.companyId)
      return NextResponse.json({ data: null })
    } catch (err) {
      if (err instanceof ContractRevenueError) {
        return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId })
      }
      throw err
    }
  },
  { requireWrite: true },
)
