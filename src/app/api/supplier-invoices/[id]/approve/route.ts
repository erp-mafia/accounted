import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { approveSupplierInvoice } from '@/lib/supplier-invoices/attest-service'

/**
 * POST /api/supplier-invoices/:id/approve: attest the invoice as the signed-in
 * user. The rules (the company's attest policy, four eyes, any or all) live in
 * lib/supplier-invoices/attest-service.ts, shared with v1, the approved agent
 * operation and the mail's link. `data` is the invoice; `data.attest` says
 * where the attest stands, so the page can tell "attested" from "your attest
 * is recorded, the others' is missing".
 */
export const POST = withRouteContext(
  'supplier_invoice.approve',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const outcome = await approveSupplierInvoice(
      { supabase, companyId, userId: user.id, log },
      { invoiceId: id, source: 'app' },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    const { invoice, approved, attest } = outcome.data
    return NextResponse.json({ data: { ...invoice, attest: { ...attest, approved } } })
  },
  { requireWrite: true },
)
