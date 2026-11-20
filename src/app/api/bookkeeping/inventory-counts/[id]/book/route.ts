import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { stockCountEnabledFor } from '@/lib/env/stock-count-switch'
import { bookStockCount } from '@/lib/bokslut/stock-count/booking'
import { stockCountDisabledResponse, stockCountErrorResponse } from '@/lib/bokslut/stock-count/route-errors'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/bookkeeping/inventory-counts/[id]/book: book the lagerförändring
 * of a signed count on balansdagen (counted value against the 14xx balances,
 * against 49xx), once per fiscal year. A closed or locked year refuses with
 * the engine's own error.
 */
export const POST = withRouteContext<Params>(
  'bookkeeping.inventory-counts.book',
  async (_request, ctx, { params }) => {
    if (!stockCountEnabledFor(ctx.companyId)) return stockCountDisabledResponse(ctx)
    const { id } = await params
    try {
      const result = await bookStockCount(ctx.supabase, ctx.companyId, ctx.user.id, id)
      return NextResponse.json({
        data: {
          count: result.count,
          adjustments: result.preview.adjustments,
          journal_entry_id: result.entry?.id ?? null,
          voucher_series: result.entry?.voucher_series ?? null,
          voucher_number: result.entry?.voucher_number ?? null,
        },
      })
    } catch (err) {
      const response = stockCountErrorResponse(err, ctx)
      if (response) return response
      throw err
    }
  },
  { requireWrite: true },
)
