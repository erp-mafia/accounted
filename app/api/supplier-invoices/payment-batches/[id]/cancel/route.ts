import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * Cancel a payment batch. Compare-and-set on status='created' so two racing
 * cancels resolve to exactly one winner; the loser gets ALREADY_CANCELLED.
 *
 * Cancelling only changes what Accounted will re-serve: a file already
 * uploaded to the bank is not recalled by this. The confirm dialog says so.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_batch.cancel',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const { data: cancelled } = await supabase
      .from('supplier_payment_batches')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by: user.id,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'created')
      .select('id, status, cancelled_at')
      .single()

    if (cancelled) {
      return NextResponse.json({ data: cancelled })
    }

    const { data: existing } = await supabase
      .from('supplier_payment_batches')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!existing) {
      return errorResponseFromCode('SI_BATCH_NOT_FOUND', log, { requestId })
    }
    return errorResponseFromCode('SI_BATCH_ALREADY_CANCELLED', log, { requestId })
  },
  { requireWrite: true },
)
