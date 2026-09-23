import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { renderSupplierPaymentBatchFile } from '@/lib/payments/batch-service'
import type { SupplierPaymentBatch, SupplierPaymentBatchItem } from '@/types'

/**
 * Download the payment file for a batch.
 *
 * The file regenerates deterministically from the stored batch + item rows:
 * msg_id and created_at were fixed at creation, so every download is
 * byte-identical and the bank's duplicate detection (keyed on MsgId) stays
 * meaningful. requireWrite because the download stamps file_generated_at and
 * bumps download_count (the tax payment-file route sets the precedent).
 *
 * Per BFL the generated file is räkenskapsinformation (underlag) for the
 * payments it initiates; the batch rows it derives from are retained.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payment_batch.file',
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
    if ((batch as SupplierPaymentBatch).status === 'cancelled') {
      return errorResponseFromCode('SI_BATCH_CANCELLED', log, { requestId })
    }

    const { data: items } = await supabase
      .from('supplier_payment_batch_items')
      .select('*')
      .eq('batch_id', id)
      .eq('company_id', companyId)
      .order('created_at', { ascending: true })

    if (!items || items.length === 0) {
      return errorResponseFromCode('SI_BATCH_NOT_FOUND', log, { requestId })
    }

    const rendered = renderSupplierPaymentBatchFile(
      batch as SupplierPaymentBatch,
      items as SupplierPaymentBatchItem[],
    )

    await supabase
      .from('supplier_payment_batches')
      .update({
        file_generated_at: new Date().toISOString(),
        download_count: ((batch as SupplierPaymentBatch).download_count ?? 0) + 1,
      })
      .eq('id', id)
      .eq('company_id', companyId)

    return new Response(rendered.content, {
      headers: {
        'Content-Type': rendered.contentType,
        'Content-Disposition': `attachment; filename="${rendered.filename}"`,
      },
    })
  },
  { requireWrite: true },
)
