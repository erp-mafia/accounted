import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { createStockCount, listStockCounts } from '@/lib/bokslut/stock-count/register'
import { SaveStockCountSchema } from '@/lib/bokslut/stock-count/schemas'
import { stockCountDisabledResponse, stockCountErrorResponse } from '@/lib/bokslut/stock-count/route-errors'

const ListQuerySchema = z.object({ fiscal_period_id: z.uuid().optional() })

/**
 * GET /api/bookkeeping/inventory-counts: the company's year-end stock counts
 * (inventeringslistor, LIV 1955:257), newest first, optionally for one
 * fiscal year, with their totals. Behind BOLAGET_COMPANY_IDS.
 */
export const GET = withRouteContext('bookkeeping.inventory-counts.list', async (request, ctx) => {
  if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
  const query = validateQuery(request, ListQuerySchema, { log: ctx.log, operation: 'bookkeeping.inventory-counts.list' })
  if (!query.success) return query.response
  const counts = await listStockCounts(ctx.supabase, ctx.companyId, { fiscalPeriodId: query.data.fiscal_period_id })
  return NextResponse.json({ data: { counts } })
})

/** POST /api/bookkeeping/inventory-counts: a new draft count with its rows. */
export const POST = withRouteContext(
  'bookkeeping.inventory-counts.create',
  async (request, ctx) => {
    if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
    const body = await validateBody(request, SaveStockCountSchema, { log: ctx.log, operation: 'bookkeeping.inventory-counts.create' })
    if (!body.success) return body.response
    try {
      const count = await createStockCount(ctx.supabase, ctx.companyId, ctx.user.id, body.data)
      return NextResponse.json({ data: count }, { status: 201 })
    } catch (err) {
      const response = stockCountErrorResponse(err, ctx)
      if (response) return response
      throw err
    }
  },
  { requireWrite: true },
)
