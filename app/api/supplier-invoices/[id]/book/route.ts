import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

// Statuses where the registration entry can still be created afterwards.
// Paid/partially paid invoices are excluded: their payment flow has already
// booked the full cash-style entry (mark-paid routes on the missing
// registration link), so booking registration now would double-post.
const BOOKABLE_STATUSES = ['registered', 'approved', 'overdue']

/**
 * POST /api/supplier-invoices/[id]/book
 *
 * The explicit "Bokför" step for companies with defer_invoice_booking (#967):
 * one person registers the invoice without bookkeeping, ekonomi books the
 * registration entry here once the kontering is verified.
 */
export const POST = withRouteContext(
  'supplier_invoice.book',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select('*, items:supplier_invoice_items(*), supplier:suppliers(id, name, supplier_type)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', log, { requestId })
    }
    if (invoice.registration_journal_entry_id) {
      return errorResponseFromCode('SI_BOOK_ALREADY_BOOKED', log, { requestId })
    }
    if (invoice.is_credit_note) {
      return errorResponseFromCode('SI_BOOK_NOT_BOOKABLE', log, { requestId })
    }
    if (!BOOKABLE_STATUSES.includes(invoice.status)) {
      return errorResponseFromCode('SI_BOOK_INVALID_STATUS', log, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // The registration entry is a faktureringsmetoden concept; under
    // kontantmetoden the invoice is booked in full when it is paid.
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()
    // Fail closed: booking with guessed settings could apply the wrong
    // method's rules, so a failed/missing settings read aborts.
    if (settingsError || !settings) {
      log.error('failed to load company settings for deferred booking', settingsError ?? undefined, { invoiceId: id })
      return errorResponseFromCode('SI_BOOK_FAILED', log, { requestId })
    }
    if ((settings.accounting_method || 'accrual') !== 'accrual') {
      return errorResponseFromCode('SI_BOOK_CASH_METHOD', log, { requestId })
    }

    const items = (invoice.items ?? []) as SupplierInvoiceItem[]

    let journalEntry
    try {
      journalEntry = await createSupplierInvoiceRegistrationEntry(
        supabase,
        companyId!,
        user.id,
        invoice as SupplierInvoice,
        items,
        invoice.supplier?.supplier_type || 'company',
        invoice.supplier?.name,
      )
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, log, { requestId })
      }
      log.error('deferred registration booking failed', err as Error, { invoiceId: id })
      return errorResponseFromCode('SI_BOOK_FAILED', log, { requestId })
    }

    // Returns null ONLY when no fiscal period covers invoice_date (other
    // failures throw). Nothing was posted, so a plain error is safe.
    if (!journalEntry) {
      return errorResponseFromCode('SI_BOOK_NO_FISCAL_PERIOD', log, {
        requestId,
        details: { invoiceDate: invoice.invoice_date },
      })
    }

    // CAS-guarded link: only claim the invoice if it is still unbooked AND
    // still in a bookable status. A concurrent book/mark-paid/credit that got
    // there first would otherwise leave this entry double-posting 2440 +
    // ingående moms (mark-paid moves to paid without touching the
    // registration link), so cancel it.
    const { data: linked, error: linkError } = await supabase
      .from('supplier_invoices')
      .update({ registration_journal_entry_id: journalEntry.id })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('registration_journal_entry_id', null)
      .in('status', BOOKABLE_STATUSES)
      .select()
      .single()

    if (linkError || !linked) {
      await cancelOrphanedPaymentEntry(
        supabase,
        companyId!,
        user.id,
        journalEntry.id,
        'Bokföring av leverantörsfaktura avbröts: fakturan bokfördes samtidigt av en annan begäran.',
      )
      return errorResponseFromCode('SI_BOOK_CONFLICT', log, { requestId })
    }

    // The invoice's retained source document (attached at registration) has
    // been floating until now: the deferred flow books later, and every
    // missing-underlag surface only accepts an ANCHORED doc
    // (document_attachments.journal_entry_id set). Anchor it to the fresh
    // registration verifikat, same as the create route does when it books
    // immediately. Never throws; a no-op when the invoice has no document.
    await anchorSupplierInvoiceDocument(supabase, companyId!, id)

    // Periodiseringar ride on the registration entry, so they can only be
    // created now. Non-blocking: the entry is committed (immutable); a
    // schedule failure is surfaced as a warning and retried from the
    // periodiseringar page.
    const warnings: Array<{ code: string; message: string }> = []
    const hasAccrualItems = items.some((item) => item.accrual_period_start && item.accrual_period_end)
    if (hasAccrualItems) {
      try {
        const scheduleResult = await createSchedulesForSupplierInvoice(
          supabase,
          companyId!,
          user.id,
          invoice as SupplierInvoice,
          items,
          journalEntry.id,
        )
        if (scheduleResult.failed > 0) {
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
    }

    return NextResponse.json({
      data: linked,
      journal_entry_id: journalEntry.id,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  },
  { requireWrite: true },
)
