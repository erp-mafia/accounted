import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkMandate } from '@/lib/invoices/autogiro/service'

const ParamsSchema = z.object({ id: z.uuid() })
const BodySchema = z.object({ customer_id: z.uuid().nullable() })

/**
 * PATCH /api/invoices/autogiro/mandates/[id]: links a payer to its customer
 * (a mandate read from Bankgirot that matched no customer), or unlinks it.
 * The customer's drafts follow (the mandate trigger).
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'autogiro.mandates.link',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    const body = await validateBody(request, BodySchema, { log, operation: 'autogiro.mandates.link' })
    if (!body.success) return body.response
    const result = await linkMandate(supabase, companyId, parsed.data.id, body.data.customer_id)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    return NextResponse.json({ data: { mandate: result.mandate } })
  },
  { requireWrite: true },
)
