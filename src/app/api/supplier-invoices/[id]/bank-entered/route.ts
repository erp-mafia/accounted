import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SupplierInvoiceBankEnteredSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  BANK_ENTERED_SUPPLIER_INVOICE_STATUSES,
  canMarkSupplierInvoiceBankEntered,
} from '@/lib/supplier-invoices/lifecycle'

/**
 * "Inlagd i banken" (#2220): record that the user entered this payment in
 * the internet bank by hand, or take that mark back.
 *
 * This is a mark, not a payment. It books nothing, changes no amount and no
 * status; the payment is still recorded by mark-paid or the bank match, and
 * the clear_supplier_invoice_bank_entered trigger drops the mark the moment
 * one of those lands. Betalfil users get the same fact from their active
 * batch instead and never need this route.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'supplier_invoice.bank_entered',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, SupplierInvoiceBankEnteredSchema, {
      log: opLog,
      operation: 'supplier_invoice.bank_entered',
    })
    if (!validation.success) return validation.response
    const { entered } = validation.data

    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select('id, status, is_credit_note, bank_entered_at')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (!invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', opLog, { requestId })
    }

    if (entered && !canMarkSupplierInvoiceBankEntered(invoice)) {
      return errorResponseFromCode('SI_BANK_ENTERED_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Idempotent: marking an already-marked invoice keeps the first timestamp
    // (that is when it went into the bank). Clearing is allowed in any
    // status: a stale mark on a settled row is never worth refusing.
    const bankEnteredAt = entered
      ? ((invoice.bank_entered_at as string | null) ?? new Date().toISOString())
      : null

    let update = supabase
      .from('supplier_invoices')
      .update({ bank_entered_at: bankEnteredAt })
      .eq('id', id)
      .eq('company_id', companyId)
    if (entered) {
      // Compare-and-set on the eligibility we just read: a payment that lands
      // between the read and this write turns into zero matched rows instead
      // of a mark on a paid invoice.
      update = update
        .in('status', [...BANK_ENTERED_SUPPLIER_INVOICE_STATUSES])
        .eq('is_credit_note', false)
    }
    const { data, error } = await update.select('id, bank_entered_at').maybeSingle()

    if (error) {
      opLog.error('supplier_invoices bank_entered_at update failed', error)
      return errorResponse(error, opLog, { requestId })
    }

    if (!data) {
      return errorResponseFromCode('SI_BANK_ENTERED_NOT_PAYABLE', opLog, {
        requestId,
        details: { reason: 'race' },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
