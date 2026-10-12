import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { scheduleCollectionForwardDrain } from '@/lib/collections/forward-hook'
import { actOnForwardIssue } from '@/lib/collections/forwarding'
import { loadInvoiceCase } from '@/lib/collections/invoice-collection'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

const ParamsSchema = z.object({ id: z.uuid() })

const ForwardActionBodySchema = z.object({
  forward_id: z.uuid(),
  /** retry: send a failed report or revert again; resolve: a person handled it, drop it from Att göra. */
  action: z.enum(['retry', 'resolve']),
})

/**
 * POST /api/invoices/[id]/collection/forwards: a person's answer to a
 * payment or credit-note report the collections provider did not take in
 * full: try a failed one again, or mark a failed or partly ignored one as
 * handled. Obligation work toward a case the company already started: it
 * runs whatever the start gates say. Answers the refreshed case.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.collection.forward',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, ForwardActionBodySchema, { log: ctx.log, operation: 'invoice.collection.forward' })
    if (!body.success) return body.response

    const db = createServiceClient()
    const outcome = await actOnForwardIssue(db, {
      companyId: ctx.companyId,
      invoiceId: parsed.data.id,
      forwardId: body.data.forward_id,
      action: body.data.action,
      userId: ctx.user.id,
    })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, ctx.log, { requestId: ctx.requestId })
    if (body.data.action === 'retry') scheduleCollectionForwardDrain(ctx.companyId)

    const view = await loadInvoiceCase({ db, log: ctx.log }, ctx.companyId, parsed.data.id, { refresh: false })
    return NextResponse.json({ data: { case: view } })
  },
  { requireWrite: true },
)
