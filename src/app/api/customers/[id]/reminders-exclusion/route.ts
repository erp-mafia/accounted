import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const ParamsSchema = z.object({ id: z.uuid() })

const BodySchema = z.object({
  /** true: "Skicka aldrig påminnelser"; false lifts it. */
  excluded: z.boolean(),
})

/**
 * PATCH /api/customers/[id]/reminders-exclusion: mark a customer "Skicka
 * aldrig påminnelser" (customers.reminders_excluded), or lift the mark. The
 * reminder policy (lib/reminders/policy.ts) then skips every invoice of the
 * customer, in the daily batch and when a person picks one. A session route
 * of its own, like collections-exclusion: the v1 customer contract does not
 * carry a field for a feature that is still dark.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'customer.reminders_exclusion',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const id = ParamsSchema.safeParse(await params)
    if (!id.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    const input = await validateBody(request, BodySchema, { log, operation: 'customer.reminders_exclusion' })
    if (!input.success) return input.response

    const { data: customer, error } = await supabase
      .from('customers')
      .update({ reminders_excluded: input.data.excluded })
      .eq('company_id', companyId)
      .eq('id', id.data.id)
      .select('id, reminders_excluded')
      .maybeSingle()
    if (error) throw error
    if (!customer) return errorResponseFromCode('CUSTOMER_NOT_FOUND', log, { requestId })
    return NextResponse.json({ data: { id: customer.id, reminders_excluded: customer.reminders_excluded === true } })
  },
  { requireWrite: true },
)
