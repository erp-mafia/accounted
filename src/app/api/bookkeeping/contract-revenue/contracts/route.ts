import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { contractRevenueEnabled } from '@/lib/env/contract-revenue-switch'
import { createContract } from '@/lib/bokslut/pagaende-arbeten/register'
import { ContractSchema } from '@/lib/bokslut/pagaende-arbeten/schemas'

/** POST /api/bookkeeping/contract-revenue/contracts: add a pågående uppdrag with its figures on a balansdag. */
export const POST = withRouteContext(
  'bookkeeping.contract-revenue.contracts.create',
  async (request, ctx) => {
    if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, ContractSchema, {
      log: ctx.log,
      operation: 'bookkeeping.contract-revenue.contracts.create',
    })
    if (!body.success) return body.response
    const row = await createContract(ctx.supabase, ctx.companyId, ctx.user.id, body.data)
    return NextResponse.json({ data: row }, { status: 201 })
  },
  { requireWrite: true },
)
