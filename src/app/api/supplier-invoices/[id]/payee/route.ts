import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { decideSupplierPayee, readInvoicePayee } from '@/lib/payments/payee-alerts'

/**
 * GET /api/supplier-invoices/:id/payee: the account the invoice states
 * against the supplier card, and whether a person must decide on it (the
 * detail page's attention line).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payee',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.uuid().safeParse(id).success) return errorResponseFromCode('SI_NOT_FOUND', log, { requestId })
    const read = await readInvoicePayee(supabase, companyId, id)
    if (!read.ok) return errorResponseFromCode(read.code, log, { requestId })
    return NextResponse.json({ data: read.view })
  },
)

const DecisionSchema = z.object({
  decision: z.enum(['confirmed', 'rejected']),
  /** Confirm only: make the account the supplier card's payment account. Defaults to true. */
  update_supplier_card: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
})

/**
 * POST /api/supplier-invoices/:id/payee: a person approves the account the
 * invoice states (covering later invoices of the supplier with it, and by
 * default putting it on the supplier card) or rejects it (payment stays held).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.payee_decision',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!z.uuid().safeParse(id).success) return errorResponseFromCode('SI_NOT_FOUND', log, { requestId })
    const validation = await validateBody(request, DecisionSchema)
    if (!validation.success) return validation.response
    const outcome = await decideSupplierPayee(
      { supabase, companyId, userId: user.id, log },
      {
        supplierInvoiceId: id,
        decision: validation.data.decision,
        updateSupplierCard: validation.data.update_supplier_card,
        note: validation.data.note ?? null,
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
