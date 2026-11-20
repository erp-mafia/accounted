import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cancelMandate } from '@/lib/invoices/autogiro/service'

const ParamsSchema = z.object({ id: z.uuid() })

/**
 * POST /api/invoices/autogiro/mandates/[id]/cancel: Accounted stops debiting
 * the mandate at once and writes the cancellation file (TK03) for the bank,
 * downloaded through GET /api/invoices/autogiro/files/[id]. Never gated by
 * the rollout: a customer who leaves must always be able to stop.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'autogiro.mandates.cancel',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    const result = await cancelMandate(supabase, companyId, user.id, parsed.data.id, todayIsoStockholm())
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    return NextResponse.json({ data: { mandate: result.mandate, file: result.file } })
  },
  { requireWrite: true },
)
