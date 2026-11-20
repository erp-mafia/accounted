import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadSettlementDetail } from '@/lib/collections/settlements-view'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const ParamsSchema = z.object({ id: z.uuid() })

/**
 * GET /api/collections/settlements/[id]: one payout with its lines, the
 * account each books to and why it waits, if it does. Read through the
 * member's own client (RLS).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'collections.settlements.get',
  async (_request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const detail = await loadSettlementDetail(ctx.supabase, ctx.companyId, parsed.data.id)
    if (!detail) return errorResponseFromCode('COLLECTION_SETTLEMENT_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    return NextResponse.json({ data: detail }, { headers: { 'Cache-Control': 'no-store' } })
  },
)
