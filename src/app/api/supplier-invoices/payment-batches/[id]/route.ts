import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * Batch detail: the batch row plus its items joined to the live invoice state
 * (status + remaining), so the view can show per-line settlement without any
 * stored progress that could go stale.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_batch.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const { data: batch } = await supabase
      .from('supplier_payment_batches')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!batch) {
      return errorResponseFromCode('SI_BATCH_NOT_FOUND', log, { requestId })
    }

    const { data: items } = await supabase
      .from('supplier_payment_batch_items')
      .select(
        '*, invoice:supplier_invoices(id, status, remaining_amount, supplier_invoice_number, arrival_number)',
      )
      .eq('batch_id', id)
      .eq('company_id', companyId)
      .order('created_at', { ascending: true })

    return NextResponse.json({ data: { ...batch, items: items ?? [] } })
  },
)
