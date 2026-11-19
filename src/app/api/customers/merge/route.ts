import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withRouteContext } from '@/lib/api/with-route-context'
import { MergeCustomersSchema, mergeCustomers } from '@/lib/customers/merge-customers'
import { sessionFailureResponse } from '@/lib/operations/session'

const MergeCustomersBodySchema = MergeCustomersSchema.extend({
  /** true: answer what would move and write nothing (the dialog's preview). */
  dry_run: z.boolean().optional(),
})

/**
 * POST /api/customers/merge: fold duplicate customer cards into the card that
 * stays (crm#1398, crm#1299). The same service as v1 POST /customers/merge
 * and the approval of gnubok_merge_customers.
 */
export const POST = withRouteContext(
  'customer.merge',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, MergeCustomersBodySchema, { log, operation: 'customer.merge' })
    if (!validation.success) return validation.response
    const { dry_run: dryRun = false, ...input } = validation.data

    const outcome = await mergeCustomers({ supabase, companyId, userId: user.id, log }, input, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data, dry_run: !!outcome.dryRun })
  },
  { requireWrite: true },
)
