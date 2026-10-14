import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { ATTEST_COMMENT_MAX } from '@/lib/supplier-invoices/attest-policy'
import { rejectSupplierInvoice } from '@/lib/supplier-invoices/attest-service'

const RejectBody = z.object({ comment: z.string().max(ATTEST_COMMENT_MAX).nullish() }).strict()

/**
 * POST /api/supplier-invoices/:id/reject: "Neka" the attest of an invoice that
 * waits for it, with an optional comment. The round starts over: approvals so
 * far stop counting and the mail's links stop working. Whoever may approve
 * may reject (lib/supplier-invoices/attest-service.ts).
 */
export const POST = withRouteContext(
  'supplier_invoice.reject',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, RejectBody)
    if (!validation.success) return validation.response

    const outcome = await rejectSupplierInvoice(
      { supabase, companyId, userId: user.id, log },
      { invoiceId: id, comment: validation.data.comment ?? null, source: 'app' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
