import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Invoice } from '@/types'

ensureInitialized() // Module-level: loads extensions so invoice.created handlers are wired.

/**
 * POST /api/invoices/[id]/finalize: "Granska och skapa".
 *
 * Turns an unnumbered draft (saved via "Spara som utkast") into a real, issued
 * invoice: allocates the F-series number and emits invoice.created (which drives
 * webhooks + the audit log). After this the invoice behaves exactly like one
 * created directly: it can be sent or cancelled (makulerad), but no longer
 * hard-deleted, because the number now belongs to the gap-free series
 * (ML 17 kap 24§).
 *
 * Only an unnumbered draft (status='draft', invoice_number IS NULL,
 * document_type='invoice') may be finalized. Numbering is idempotent inside the
 * generate_invoice_number RPC, but the explicit guard keeps the contract clear.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.finalize',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params

    const { data: invoice, error: fetchError } = await supabase
      .from('invoices')
      .select('id, status, invoice_number, document_type, is_self_billed')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }

    // Only an unnumbered draft can be finalized. Numbered drafts are already
    // issued (cancel via makulering instead); sent/paid invoices are immutable.
    // A null document_type means a plain invoice (older rows / default).
    // Self-billed drafts are counterparty documents (självfakturering) and must
    // not be allocated an F-series number through this flow even if a direct
    // API call left one unnumbered.
    const docType = invoice.document_type ?? 'invoice'
    if (
      invoice.status !== 'draft' ||
      invoice.invoice_number ||
      docType !== 'invoice' ||
      invoice.is_self_billed
    ) {
      return errorResponseFromCode('INVOICE_FINALIZE_NOT_DRAFT', log, { requestId })
    }

    try {
      await ensureInvoiceNumber(supabase, companyId!, invoice as Invoice)
    } catch (err) {
      log.error('failed to assign invoice number on finalize', err as Error, { invoiceId: id })
      return errorResponseFromCode('INVOICE_CREATE_NUMBER_ASSIGN_FAILED', log, { requestId })
    }

    const { data: completeInvoice, error: refetchError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .single()

    // The number was already allocated, so the invoice is finalized in the DB,
    // but if the re-read fails we cannot emit invoice.created with a complete
    // payload, which would silently drop the audit-log entry, webhooks, and any
    // extension wired to the event. Surface it as a 500 rather than returning
    // 200 with a null body and a hollow success toast. A reload shows the
    // (correctly numbered) invoice; the failure is now visible in monitoring.
    if (refetchError || !completeInvoice) {
      log.error(
        'finalize: number allocated but invoice re-read failed; invoice.created not emitted',
        refetchError as Error,
        { invoiceId: id },
      )
      return errorResponseFromCode('INVOICE_FINALIZE_INCOMPLETE', log, { requestId })
    }

    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice: completeInvoice as Invoice, companyId: companyId!, userId: user.id },
    })

    return NextResponse.json({ data: completeInvoice })
  },
  { requireWrite: true },
)
