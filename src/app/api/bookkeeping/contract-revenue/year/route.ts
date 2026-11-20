import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { contractRevenueEnabled } from '@/lib/env/contract-revenue-switch'
import {
  ContractRevenueError,
  bookContractRevenueYear,
  previewContractRevenueYear,
} from '@/lib/bokslut/pagaende-arbeten/register'
import { BookContractRevenueSchema } from '@/lib/bokslut/pagaende-arbeten/schemas'

function failure(err: unknown, ctx: { log: Parameters<typeof errorResponseFromCode>[1]; requestId?: string }) {
  if (err instanceof ContractRevenueError) {
    return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId, details: err.details })
  }
  throw err
}

/**
 * GET /api/bookkeeping/contract-revenue/year?fiscal_period_id=: what booking
 * the year would do: each uppdrag's position on balansdagen, the
 * adjustment's lines against what the ledger holds, and any open issue.
 */
export const GET = withRouteContext('bookkeeping.contract-revenue.year.preview', async (request, ctx) => {
  if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
  const parsed = BookContractRevenueSchema.safeParse({
    fiscal_period_id: new URL(request.url).searchParams.get('fiscal_period_id'),
  })
  if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  try {
    const preview = await previewContractRevenueYear(ctx.supabase, ctx.companyId, parsed.data.fiscal_period_id)
    return NextResponse.json({ data: preview })
  } catch (err) {
    return failure(err, ctx)
  }
})

/**
 * POST /api/bookkeeping/contract-revenue/year: book the year's change in the
 * pågående arbeten on balansdagen (K3 23.21, 23.27), one year_end verifikat
 * through the posting port; booking again books only what changed.
 */
export const POST = withRouteContext(
  'bookkeeping.contract-revenue.year.book',
  async (request, ctx) => {
    if (!contractRevenueEnabled()) return errorResponseFromCode('CONTRACT_REVENUE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, BookContractRevenueSchema, {
      log: ctx.log,
      operation: 'bookkeeping.contract-revenue.year.book',
    })
    if (!body.success) return body.response
    try {
      const { entry } = await bookContractRevenueYear(ctx.supabase, ctx.companyId, ctx.user.id, body.data.fiscal_period_id)
      return NextResponse.json({
        data: entry
          ? { journal_entry_id: entry.id, voucher_series: entry.voucher_series ?? null, voucher_number: entry.voucher_number ?? null }
          : null,
      })
    } catch (err) {
      return failure(err, ctx)
    }
  },
  { requireWrite: true },
)
