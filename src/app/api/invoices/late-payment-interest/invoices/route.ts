import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLateInterestInvoices } from '@/lib/invoices/late-interest-invoices'

const CreateLateInterestInvoicesSchema = z.object({
  /** The late-paid invoices the page offered, as it showed them. */
  invoice_ids: z.array(z.string().uuid()).min(1).max(500),
})

/**
 * POST /api/invoices/late-payment-interest/invoices: Skapa räntefaktura on
 * the Dröjsmålsränta page. One unnumbered draft per customer and currency,
 * charging the dröjsmålsränta of the named invoices
 * (lib/invoices/late-interest-invoices.ts). Nothing is sent or booked: the
 * drafts are reviewed and sent like any invoice. 409 when a named invoice may
 * no longer be charged (charged since, or not paid in full).
 */
export const POST = withRouteContext(
  'invoices.late_payment_interest.create_invoices',
  async (request, { supabase, user, companyId, log, requestId }) => {
    const validation = await validateBody(request, CreateLateInterestInvoicesSchema, {
      log,
      operation: 'invoices.late_payment_interest.create_invoices',
    })
    if (!validation.success) return validation.response

    const result = await createLateInterestInvoices(supabase, {
      companyId,
      userId: user.id,
      invoiceIds: validation.data.invoice_ids,
    })
    if (!result.ok) {
      if ('dbError' in result) return errorResponse(result.dbError, log, { requestId })
      return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    }
    if (result.created.length === 0) {
      const first = result.failed[0]
      return errorResponseFromCode(first.code, log, { requestId, details: { ...first.details, failed: result.failed } })
    }
    return NextResponse.json({ data: { created: result.created, failed: result.failed } }, { status: 201 })
  },
  { requireWrite: true },
)
