import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { contractRevenueEnabled } from '@/lib/env/contract-revenue-switch'
import { ContractRevenueError, deleteContract, updateContract } from '@/lib/bokslut/pagaende-arbeten/register'
import { ContractSchema } from '@/lib/bokslut/pagaende-arbeten/schemas'

type Params = { params: Promise<{ id: string }> }

/** PUT /api/bookkeeping/contract-revenue/contracts/[id]: state an uppdrag's figures anew (e.g. for the next balansdag). */
export const PUT = withRouteContext<Params>(
  'bookkeeping.contract-revenue.contracts.update',
  async (request, ctx, { params }) => {
    if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const { id } = await params
    const body = await validateBody(request, ContractSchema, {
      log: ctx.log,
      operation: 'bookkeeping.contract-revenue.contracts.update',
    })
    if (!body.success) return body.response
    try {
      const row = await updateContract(ctx.supabase, ctx.companyId, id, body.data)
      return NextResponse.json({ data: row })
    } catch (err) {
      if (err instanceof ContractRevenueError) return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId })
      throw err
    }
  },
  { requireWrite: true },
)

/**
 * DELETE /api/bookkeeping/contract-revenue/contracts/[id]: remove an
 * uppdrag. Its position leaves the next booking: a finished uppdrag goes
 * once its last year is booked; an unfinished one reverses its position.
 */
export const DELETE = withRouteContext<Params>(
  'bookkeeping.contract-revenue.contracts.delete',
  async (_request, ctx, { params }) => {
    if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const { id } = await params
    try {
      await deleteContract(ctx.supabase, ctx.companyId, id)
      return NextResponse.json({ data: { id } })
    } catch (err) {
      if (err instanceof ContractRevenueError) return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId })
      throw err
    }
  },
  { requireWrite: true },
)
