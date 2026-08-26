import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  bookInvoiceDeferred,
  INVOICE_BOOKABLE_STATUSES,
} from '@/lib/invoices/book-invoice-deferred'
import type { CompanySettings, EntityType } from '@/types'

/**
 * POST /api/invoices/[id]/book
 *
 * The explicit "Bokför" step for companies with defer_invoice_booking (#967):
 * one person creates and sends the invoice without bookkeeping, ekonomi books
 * the revenue entry here once the kontering is verified. The core lives in
 * lib/invoices/book-invoice-deferred.ts, shared with the bulk Bokför route.
 */
export const POST = withRouteContext(
  'invoice.book',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const { data: invoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(name), items:invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }
    if (invoice.journal_entry_id) {
      return errorResponseFromCode('INVOICE_BOOK_ALREADY_BOOKED', log, { requestId })
    }
    const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
    if (!isRealInvoice || invoice.credited_invoice_id) {
      return errorResponseFromCode('INVOICE_BOOK_NOT_BOOKABLE', log, { requestId })
    }
    if (!INVOICE_BOOKABLE_STATUSES.includes(invoice.status)) {
      return errorResponseFromCode('INVOICE_BOOK_INVALID_STATUS', log, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // The revenue-at-issue entry is a faktureringsmetoden concept; under
    // kontantmetoden the sale is booked in full when it is paid.
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()
    // Fail closed: booking with guessed settings could apply the wrong
    // method's or entity type's rules, so a failed/missing settings read aborts.
    if (settingsError || !settings) {
      log.error('failed to load company settings for deferred booking', settingsError ?? undefined, { invoiceId: id })
      return errorResponseFromCode('INVOICE_BOOK_FAILED', log, { requestId })
    }
    if ((settings.accounting_method || 'accrual') !== 'accrual') {
      return errorResponseFromCode('INVOICE_BOOK_CASH_METHOD', log, { requestId })
    }
    const entityType = ((settings as Partial<CompanySettings>).entity_type as EntityType) || 'enskild_firma'

    const result = await bookInvoiceDeferred({
      supabase,
      companyId: companyId!,
      userId: user.id,
      invoice,
      entityType,
      log,
    })

    if (!result.ok) {
      if (result.kind === 'domain') {
        return errorResponse(result.error, log, { requestId })
      }
      return errorResponseFromCode(result.errorCode, log, {
        requestId,
        ...(result.details ? { details: result.details } : {}),
      })
    }

    return NextResponse.json({
      data: result.invoice,
      journal_entry_id: result.journalEntryId,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    })
  },
  { requireWrite: true },
)
