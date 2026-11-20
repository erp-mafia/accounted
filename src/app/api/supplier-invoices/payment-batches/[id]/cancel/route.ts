import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { cancelPaymentBatch } from '@/lib/payments/batch-operations'

/**
 * Cancel a payment batch. Compare-and-set on status='created' so two racing
 * cancels resolve to exactly one winner; the loser gets ALREADY_CANCELLED.
 *
 * Cancelling only changes what Accounted will re-serve: a file already
 * uploaded to the bank is not recalled by this. The confirm dialog says so.
 * Rules in lib/payments/batch-operations.ts (shared with v1 and MCP).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_batch.cancel',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const outcome = await cancelPaymentBatch({ supabase, companyId, userId: user.id, log }, id, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) throw new Error('unreachable: cancel ran without a dry run')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
