/**
 * Ingest matcher: the open customer invoice an income row pays (OCR or
 * reference first, then amount and customer: matchInvoiceCandidates), as a
 * hint on the row (potential_invoice_id). One invoice per batch: a claimed
 * invoice is never offered to a second row.
 *
 * A company that switched on auto_book_customer_payments gets the row booked
 * instead when its reference field names that invoice exactly
 * (invoiceNamedExactly, lib/invoices/customer-payment-auto-book.ts), through
 * the function a person's confirmation books with, as a match nobody
 * confirmed. A booking that is refused leaves the hint, as for every other
 * company. Otherwise this pass never books: the match route does when a
 * person confirms.
 */
import type { IngestMatcher } from '@/lib/transactions/ingest-matcher'
import { autoBookCustomerPayment, invoiceNamedExactly, readCustomerPaymentAutoBook } from './customer-payment-auto-book'
import { bestInvoiceMatch, CONFIDENCE } from './invoice-matching'

interface CustomerInvoiceIngestState {
  /**
   * The company's auto_book_customer_payments switch, read on the batch's
   * first row whose reference names its invoice exactly, then kept. Never
   * rejects: an unreadable switch is off.
   */
  autoBook(): Promise<boolean>
}

export const customerInvoiceIngestMatcher: IngestMatcher<CustomerInvoiceIngestState> = {
  id: 'customer-invoice',
  order: 300,
  module: 'invoicing',
  direction: 'income',
  onReread: true,
  // Reads nothing yet: most batches have no row the switch could book.
  async prepare(batch) {
    let read: Promise<boolean> | null = null
    return {
      autoBook: () =>
        (read ??= readCustomerPaymentAutoBook(batch.supabase, batch.companyId).catch((error: unknown) => {
          batch.log.warn('auto-book switch unreadable; payments stay suggestions', {
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        })),
    }
  },
  async match(batch, state, { tx, raw, reread }) {
    // OCR/reference matching is part of the scoring (matchInvoiceCandidates)
    const pool = await batch.pools.customerInvoices()
    const bestMatch = bestInvoiceMatch(tx, pool, 0.50)
    if (!bestMatch || batch.claims.has('customer_invoice', bestMatch.invoice.id)) return 'none'

    // The payer named the invoice by its OCR number: booked, where the
    // company asked for it and the booking takes it.
    if (state && bestMatch.confidence >= CONFIDENCE.OCR_REFERENCE_MATCH) {
      const exact = invoiceNamedExactly(tx.reference ?? raw.reference ?? null, tx.currency ?? raw.currency, pool.invoices)
      if (exact && exact.id === bestMatch.invoice.id && (await state.autoBook())) {
        const booked = await autoBookCustomerPayment(
          { supabase: batch.supabase, companyId: batch.companyId, userId: batch.userId, log: batch.log },
          tx,
          exact,
        )
        if (booked.ok) {
          batch.claims.add('customer_invoice', exact.id)
          batch.result.auto_matched_invoices++
          batch.result.auto_booked_payments = (batch.result.auto_booked_payments ?? 0) + 1
          batch.log.info('customer payment booked by its OCR reference', {
            transactionId: tx.id,
            invoiceId: exact.id,
            journalEntryId: booked.journalEntryId,
            invoiceStatus: booked.invoiceStatus,
          })
          return 'explained'
        }
        // Refused: the row gets the hint below, as without the switch.
        batch.log.info('customer payment left as a suggestion', { transactionId: tx.id, invoiceId: exact.id, code: booked.code })
      }
    }

    const existingHint = tx.potential_invoice_id ?? null
    if (reread && existingHint && (existingHint === bestMatch.invoice.id || bestMatch.confidence < CONFIDENCE.OCR_REFERENCE_MATCH)) {
      // The hint stands: the re-read brought nothing stronger.
      return 'explained'
    }
    await batch.supabase
      .from('transactions')
      .update({ potential_invoice_id: bestMatch.invoice.id })
      .eq('id', tx.id)

    await batch.logMatch(tx.id, 'auto_suggested', {
      invoiceId: bestMatch.invoice.id,
      matchConfidence: bestMatch.confidence,
      matchMethod: bestMatch.matchReason,
    })

    batch.claims.add('customer_invoice', bestMatch.invoice.id)
    batch.result.auto_matched_invoices++
    // Skip the mapping engine: the row has an invoice match. Auto-
    // categorisation would create an orphaned journal entry that conflicts
    // with the eventual invoice payment entry.
    return 'explained'
  },
}
