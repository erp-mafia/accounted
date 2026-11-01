import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  bookSupplierSettlement,
  planSupplierSettlement,
  supplierSettlementInput,
  type SettleableSupplierInvoice,
} from '@/lib/invoices/settle-supplier-payment'
import { sessionFailureResponse } from '@/lib/operations/session'
import { writeCompanySettings } from '@/lib/company/settings-writer'

/**
 * POST /api/supplier-invoices/[id]/mark-paid
 *
 * "Registrera betalning". The rules and the booking are
 * lib/invoices/settle-supplier-payment.ts, shared with the preview and the v1
 * door; this route owns the request and the dialog's last-used payment account.
 */
export const POST = withRouteContext(
  'supplier_invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, MarkSupplierInvoicePaidSchema, {
      log: opLog,
      operation: 'supplier_invoice.mark_paid',
    })
    if (!validation.success) return validation.response
    const input = supplierSettlementInput(validation.data)

    const { data: invoice, error: fetchError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', opLog, { requestId })
    }

    const opCtx = { supabase, companyId: companyId!, userId: user.id, log: opLog }
    const planned = await planSupplierSettlement(opCtx, invoice as SettleableSupplierInvoice, input)
    if (!planned.ok) return sessionFailureResponse(planned, opLog, requestId)

    const settled = await bookSupplierSettlement(opCtx, planned.plan, { user_id: user.id, actor_type: 'user' })
    if (!settled.ok) return sessionFailureResponse(settled, opLog, requestId)

    // Remember the chosen payment account so the next dialog can default to it.
    // Only update when the caller actually picked one: the MCP / agent path
    // sends no payment_account and shouldn't churn this setting.
    const { paymentAccount } = input
    if (paymentAccount && paymentAccount !== planned.plan.lastPaymentAccount) {
      const remembered = await writeCompanySettings(
        { supabase, companyId: companyId!, userId: user.id, log: opLog },
        { last_supplier_payment_account: paymentAccount },
      )
      // A company setting: a member's choice is not kept. Never a failed payment.
      if (!remembered.ok) opLog.info('last_supplier_payment_account not kept', { code: remembered.code })
    }

    return NextResponse.json({
      success: true,
      status: settled.newStatus,
      paid_amount: settled.newPaidAmount,
      remaining_amount: settled.newRemaining,
      journal_entry_id: settled.journalEntryId,
      // The registration verifikat this payment booked first, when it did.
      ...(settled.registrationJournalEntryId ? { registration_journal_entry_id: settled.registrationJournalEntryId } : {}),
      ...(settled.warnings.length > 0
        ? { warnings: settled.warnings.map((w) => ({ code: w.code, message: w.message_sv })) }
        : {}),
    })
  },
  { requireWrite: true },
)
