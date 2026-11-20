import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PreviewSupplierPaymentBatchSchema } from '@/lib/api/schemas'
import { previewSupplierPaymentBatch } from '@/lib/payments/batch-service'

/**
 * Preview a payment batch before creating it: which of the selected invoices
 * are eligible (with per-line defaults, payee, reference and warnings), which
 * are excluded and why, and whether the company's own bank details (pain.001
 * debtor) are complete. Same evaluation as create, so the preview can never
 * promise what create would refuse.
 *
 * requireWrite matches create: a viewer role has no business staging payment
 * instructions it could never create.
 */
export const POST = withRouteContext(
  'supplier_invoice.payment_batch.preview',
  async (request, { supabase, companyId, log }) => {
    const validation = await validateBody(request, PreviewSupplierPaymentBatchSchema, {
      log,
      operation: 'supplier_invoice.payment_batch.preview',
    })
    if (!validation.success) return validation.response

    const preview = await previewSupplierPaymentBatch(supabase, companyId, {
      ids: validation.data.ids,
    })

    return NextResponse.json({ data: preview })
  },
  { requireWrite: true },
)
