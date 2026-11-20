import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { deleteStockCount, updateStockCount } from '@/lib/bokslut/stock-count/register'
import { getStockCount } from '@/lib/bokslut/stock-count/signing'
import { previewStockCountBooking } from '@/lib/bokslut/stock-count/booking'
import { SaveStockCountSchema } from '@/lib/bokslut/stock-count/schemas'
import { stockCountDisabledResponse, stockCountErrorResponse } from '@/lib/bokslut/stock-count/route-errors'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/bookkeeping/inventory-counts/[id]: one count with its rows and
 * totals, in step with its BankID signing; a signed count also answers the
 * lagerförändring booking it would make (counted against the ledger).
 */
export const GET = withRouteContext<Params>('bookkeeping.inventory-counts.get', async (_request, ctx, { params }) => {
  if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
  const { id } = await params
  try {
    const count = await getStockCount(ctx.supabase, ctx.companyId, ctx.user.id, id)
    const booking = count.status === 'signed' ? await previewStockCountBooking(ctx.supabase, ctx.companyId, id, { record: count }) : null
    return NextResponse.json({ data: { count, booking } })
  } catch (err) {
    const response = stockCountErrorResponse(err, ctx)
    if (response) return response
    throw err
  }
})

/** PUT /api/bookkeeping/inventory-counts/[id]: change a draft (its rows are replaced). */
export const PUT = withRouteContext<Params>(
  'bookkeeping.inventory-counts.update',
  async (request, ctx, { params }) => {
    if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
    const { id } = await params
    const body = await validateBody(request, SaveStockCountSchema, { log: ctx.log, operation: 'bookkeeping.inventory-counts.update' })
    if (!body.success) return body.response
    try {
      const count = await updateStockCount(ctx.supabase, ctx.companyId, id, body.data)
      return NextResponse.json({ data: count })
    } catch (err) {
      const response = stockCountErrorResponse(err, ctx)
      if (response) return response
      throw err
    }
  },
  { requireWrite: true },
)

/** DELETE /api/bookkeeping/inventory-counts/[id]: delete a draft; a signed count is kept. */
export const DELETE = withRouteContext<Params>(
  'bookkeeping.inventory-counts.delete',
  async (_request, ctx, { params }) => {
    if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
    const { id } = await params
    try {
      await deleteStockCount(ctx.supabase, ctx.companyId, id)
      return NextResponse.json({ data: { id, deleted: true } })
    } catch (err) {
      const response = stockCountErrorResponse(err, ctx)
      if (response) return response
      throw err
    }
  },
  { requireWrite: true },
)
