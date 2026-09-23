import type { SupabaseClient } from '@supabase/supabase-js'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import type { Logger } from '@/lib/logger'
import type { Customer, EntityType, Invoice, InvoiceItem } from '@/types'

// Statuses where the revenue entry can still be created afterwards. Paid
// invoices are excluded: their payment flow has already booked the full
// cash-style entry (mark-paid routes on the missing journal-entry link), so
// booking the sale now would double-post revenue.
export const INVOICE_BOOKABLE_STATUSES = ['sent', 'overdue']

export interface BookDeferredWarning {
  code: string
  message: string
}

export type BookInvoiceDeferredResult =
  | {
      ok: true
      /** The invoice row as returned by the CAS-guarded link update. */
      invoice: Invoice
      journalEntryId: string
      warnings: BookDeferredWarning[]
    }
  | {
      ok: false
      /** Typed bookkeeping error: map with errorResponse()/getErrorMessage(). */
      kind: 'domain'
      error: unknown
    }
  | {
      ok: false
      kind: 'code'
      errorCode: string
      details?: Record<string, unknown>
    }

/**
 * The deferred "Bokför" core (#967): create the revenue verifikat for an
 * already-sent invoice and claim it with a CAS-guarded link. Shared by
 * POST /api/invoices/[id]/book and POST /api/invoices/bulk-book so the two
 * can never drift apart. The caller is responsible for the eligibility
 * guards (real invoice, bookable status, unbooked, accrual method).
 */
export async function bookInvoiceDeferred(opts: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  invoice: Invoice & {
    customer?: (Customer & { name?: string }) | { name?: string } | null
    items?: InvoiceItem[] | null
  }
  entityType: EntityType
  log: Logger
}): Promise<BookInvoiceDeferredResult> {
  const { supabase, companyId, userId, invoice, entityType, log } = opts
  const id = invoice.id

  let journalEntry
  try {
    journalEntry = await createInvoiceJournalEntry(
      supabase,
      companyId,
      userId,
      invoice as Invoice,
      entityType,
      invoice.customer?.name,
    )
  } catch (err) {
    if (isBookkeepingError(err)) {
      return { ok: false, kind: 'domain', error: err }
    }
    log.error('deferred invoice booking failed', err as Error, { invoiceId: id })
    return { ok: false, kind: 'code', errorCode: 'INVOICE_BOOK_FAILED' }
  }

  // Returns null ONLY when no fiscal period covers invoice_date (other
  // failures throw). Nothing was posted, so a plain error is safe.
  if (!journalEntry) {
    return {
      ok: false,
      kind: 'code',
      errorCode: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
      details: { invoiceDate: invoice.invoice_date },
    }
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
    .in('status', INVOICE_BOOKABLE_STATUSES)
    .is('credited_invoice_id', null)
    .select()
    .single()

  if (linkError || !linked) {
    await cancelOrphanedPaymentEntry(
      supabase,
      companyId,
      userId,
      journalEntry.id,
      'Bokföring av kundfaktura avbröts: fakturan bokfördes samtidigt av en annan begäran.',
    )
    return { ok: false, kind: 'code', errorCode: 'INVOICE_BOOK_CONFLICT' }
  }

  const warnings: BookDeferredWarning[] = []

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
        companyId,
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
      companyId,
      userId,
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

  return { ok: true, invoice: linked as Invoice, journalEntryId: journalEntry.id, warnings }
}
