import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { changeSupplierInvoiceSupplier } from '@/lib/supplier-invoices/change-supplier'
import { sessionFailureResponse } from '@/lib/operations/session'

const ChangeSupplierSchema = z.object({
  supplier_id: z.string().uuid(),
})

/**
 * POST /api/supplier-invoices/[id]/change-supplier: Byt leverantör on an
 * unpaid, unattested invoice registered on the wrong supplier. A posted
 * registration verifikat gets its text corrected inside the same verifikat
 * (inline rättelse, open period only). Rules live in
 * lib/supplier-invoices/change-supplier.ts, shared with v1 and MCP
 * (operation supplier-invoices.change-supplier).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.change_supplier',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.uuid().safeParse(id).success) return errorResponseFromCode('SI_NOT_FOUND', log, { requestId })
    const validated = await validateBody(request, ChangeSupplierSchema, { log, operation: 'supplier_invoice.change_supplier' })
    if (!validated.success) return validated.response

    const outcome = await changeSupplierInvoiceSupplier(
      { supabase, companyId, userId: user.id, log },
      id,
      validated.data.supplier_id,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
