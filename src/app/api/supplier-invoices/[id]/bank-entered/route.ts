import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SupplierInvoiceBankEnteredSchema } from '@/lib/api/schemas'
import { setSupplierInvoiceBankEntered } from '@/lib/supplier-invoices/manage'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * "Inlagd i banken" (#2220): record that the user entered this payment in
 * the internet bank by hand, or take that mark back.
 *
 * This is a mark, not a payment. It books nothing, changes no amount and no
 * status; the payment is still recorded by mark-paid or the bank match, and
 * the clear_supplier_invoice_bank_entered trigger drops the mark the moment
 * one of those lands. Betalfil users get the same fact from their active
 * batch instead and never need this route. Rules live in
 * lib/supplier-invoices/manage.ts, shared with v1
 * supplier-invoices.mark-bank-entered.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.bank_entered',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, SupplierInvoiceBankEnteredSchema, {
      log: opLog,
      operation: 'supplier_invoice.bank_entered',
    })
    if (!validation.success) return validation.response

    const outcome = await setSupplierInvoiceBankEntered(
      { supabase, companyId, userId: user.id, log: opLog },
      id,
      validation.data.entered,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
