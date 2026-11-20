import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getSupplierInvoiceAttestState } from '@/lib/supplier-invoices/attest-service'

/**
 * GET /api/supplier-invoices/:id/attestations: where the attest of the
 * invoice stands (who attested, who is left, the latest rejection and its
 * comment, every decision) and whether the signed-in user may attest or
 * reject it now. The invoice page's attest panel reads it.
 */
export const GET = withRouteContext(
  'supplier_invoice.attestations',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const outcome = await getSupplierInvoiceAttestState({ supabase, companyId, userId: user.id, log }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
