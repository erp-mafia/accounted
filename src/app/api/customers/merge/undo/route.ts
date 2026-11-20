import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { withRouteContext } from '@/lib/api/with-route-context'
import { undoCustomerMerge } from '@/lib/customers/merge-customers'
import { sessionFailureResponse } from '@/lib/operations/session'

const UndoCustomerMergeSchema = z.object({ merge_id: z.string().uuid() })

/** POST /api/customers/merge/undo: undo a customer merge within 30 days (the toast's Ångra). */
export const POST = withRouteContext(
  'customer.merge_undo',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, UndoCustomerMergeSchema, { log, operation: 'customer.merge_undo' })
    if (!validation.success) return validation.response

    const outcome = await undoCustomerMerge({ supabase, companyId, userId: user.id, log }, validation.data.merge_id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('customer.merge_undo: unexpected dry-run outcome')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
