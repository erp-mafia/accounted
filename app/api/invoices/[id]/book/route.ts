import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import type { CompanySettings, EntityType, Invoice, InvoiceItem } from '@/types'

// Statuses where the revenue entry can still be created afterwards. Paid
// invoices are excluded: their payment flow has already booked the full
// cash-style entry (mark-paid routes on the missing journal-entry link), so
// booking the sale now would double-post revenue.
const BOOKABLE_STATUSES = ['sent', 'overdue']

/**
 * POST /api/invoices/[id]/book
 *
 * The explicit "Bokför" step for companies with defer_invoice_booking (#967):
 * one person creates and sends the invoice without bookkeeping, ekonomi books
 * the revenue entry here once the kontering is verified.
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
    if (!BOOKABLE_STATUSES.includes(invoice.status)) {
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

    let journalEntry
    try {
      journalEntry = await createInvoiceJournalEntry(
        supabase,
        companyId!,
        user.id,
        invoice as Invoice,
        entityType,
        invoice.customer?.name,
      )
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, log, { requestId })
      }
      log.error('deferred invoice booking failed', err as Error, { invoiceId: id })
      return errorResponseFromCode('INVOICE_BOOK_FAILED', log, { requestId })
    }

    // Returns null ONLY when no fiscal period covers invoice_date (other
    // failures throw). Nothing was posted, so a plain error is safe.
    if (!journalEntry) {
      return errorResponseFromCode('INVOICE_BOOK_NO_FISCAL_PERIOD', log, {
        requestId,
        details: { invoiceDate: invoice.invoice_date },
      })
    }

    // CAS-guarded link: only claim the invoice if it is still unbooked, still
    // in a bookable status, and still uncredited. A concurrent
    // book/mark-paid/credit that got there first would otherwise leave this
    // entry double-posting revenue, so cancel it.
    const { data: linked, error: linkError } = await supabase
      .from('invoices')
      .update({ journal_entry_id: journalEntry.id })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .in('status', BOOKABLE_STATUSES)
      .is('credited_invoice_id', null)
      .select()
      .single()

    if (linkError || !linked) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId!,
        user.id,
        journalEntry.id,
        'Bokföring av kundfaktura avbröts: fakturan bokfördes samtidigt av en annan begäran.',
      )
      return errorResponseFromCode('INVOICE_BOOK_CONFLICT', log, { requestId })
    }

    const warnings: Array<{ code: string; message: string }> = []

    // The send flow archived the exact delivered PDF before this deferred
    // journal entry existed. Attach the newest successful delivery snapshot now.
    const { data: deliveryDocumentId, error: deliveryDocumentError } = await supabase.rpc(
      'latest_sent_invoice_delivery_document',
      { p_company_id: companyId, p_invoice_id: id },
    )

    if (deliveryDocumentError) {
      log.error('failed to find delivered invoice PDF for deferred booking', deliveryDocumentError, {
        invoiceId: id,
      })
      warnings.push({
        code: 'PDF_LINK_FAILED',
        message: 'Fakturan bokfördes, men den arkiverade PDF-filen kunde inte kopplas till verifikationen.',
      })
    } else if (typeof deliveryDocumentId === 'string') {
      try {
        await linkToJournalEntry(
          supabase,
          companyId!,
          deliveryDocumentId,
          journalEntry.id,
        )
      } catch (err) {
        log.error('failed to link delivered invoice PDF on deferred booking', err as Error, {
          invoiceId: id,
          documentId: deliveryDocumentId,
        })
        warnings.push({
          code: 'PDF_LINK_FAILED',
          message: 'Fakturan bokfördes, men den arkiverade PDF-filen kunde inte kopplas till verifikationen.',
        })
      }
    }

    // Periodiseringar ride on the revenue entry, so they can only be created
    // now. Non-blocking: the entry is committed (immutable); a schedule
    // failure is surfaced as a warning and retried from the periodiseringar
    // page.
    try {
      const accrual = await createSchedulesForCustomerInvoice(
        supabase,
        companyId!,
        user.id,
        invoice as Invoice,
        (invoice.items as InvoiceItem[] | null) ?? [],
        journalEntry.id,
        entityType,
      )
      if (accrual.failed > 0) {
        warnings.push({
          code: 'ACCRUAL_SCHEDULE_FAILED',
          message:
            'Fakturan bokfördes, men en eller flera periodiseringar kunde inte ' +
            'skapas. Kontrollera under Bokföring → Periodiseringar.',
        })
      }
    } catch (err) {
      log.error('accrual schedule creation failed on deferred booking', err as Error, { invoiceId: id })
      warnings.push({
        code: 'ACCRUAL_SCHEDULE_FAILED',
        message:
          'Fakturan bokfördes, men periodiseringarna kunde inte skapas. ' +
          'Kontrollera under Bokföring → Periodiseringar.',
      })
    }

    return NextResponse.json({
      data: linked,
      journal_entry_id: journalEntry.id,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  },
  { requireWrite: true },
)
