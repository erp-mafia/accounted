import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { readCollectionsEnv } from '@/lib/collections/flags'
import { collectionsRouteGate } from '@/lib/collections/settings-routes'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const ParamsSchema = z.object({ id: z.uuid() })

const BodySchema = z.object({
  /** true: "Skicka aldrig till inkasso"; false lifts it. */
  excluded: z.boolean(),
})

/**
 * PATCH /api/customers/[id]/collections-exclusion: mark a customer "Skicka
 * aldrig till inkasso" (customers.collections_excluded), or lift the mark.
 * The daily collections batch never proposes a marked customer's invoices,
 * and a handover or a start from the invoice is refused (eligibility block
 * debtor_excluded); cases already open carry on.
 *
 * A session route of its own rather than a field on PATCH /api/customers/[id]
 * (DECISIONS.md): that schema is the v1 customer contract, and this flag
 * answers only while collections is offered to the company (the
 * customer_exclusion start path: kill switch, pilot list and the paid
 * capability or a sandbox, before activation too), so the public API does
 * not carry a field for a feature that is still dark.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'customer.collections_exclusion',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, BodySchema, { log: ctx.log, operation: 'customer.collections_exclusion' })
    if (!body.success) return body.response

    const refused = await collectionsRouteGate(ctx, 'customer_exclusion', readCollectionsEnv())
    if (refused) return refused

    const { data, error } = await ctx.supabase
      .from('customers')
      .update({ collections_excluded: body.data.excluded })
      .eq('id', parsed.data.id)
      .eq('company_id', ctx.companyId)
      .select('id, collections_excluded')
      .maybeSingle()
    if (error) throw error
    if (!data) return errorResponseFromCode('CUSTOMER_NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    return NextResponse.json({ data: { id: data.id, collections_excluded: data.collections_excluded === true } })
  },
  { requireWrite: true },
)
