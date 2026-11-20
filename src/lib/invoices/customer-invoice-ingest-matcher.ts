/**
 * Ingest matcher: the open customer invoice an income row pays (OCR or
 * reference first, then amount and customer: matchInvoiceCandidates), as a
 * hint on the row (potential_invoice_id). Never books: the match route does
 * when a person confirms. One invoice per batch: a claimed invoice is never
 * offered to a second row.
 */
import type { IngestMatcher } from '@/lib/transactions/ingest-matcher'
import { bestInvoiceMatch, CONFIDENCE } from './invoice-matching'

export const customerInvoiceIngestMatcher: IngestMatcher = {
  id: 'customer-invoice',
  order: 300,
  module: 'invoicing',
  direction: 'income',
  onReread: true,
  async match(batch, _state, { tx, reread }) {
    // OCR/reference matching is part of the scoring (matchInvoiceCandidates)
    const pool = await batch.pools.customerInvoices()
    const bestMatch = bestInvoiceMatch(tx, pool, 0.50)
    if (!bestMatch || batch.claims.has('customer_invoice', bestMatch.invoice.id)) return 'none'

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
