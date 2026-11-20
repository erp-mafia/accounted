/**
 * Ingest matcher: the supplier invoice heuristics (findSupplierInvoiceMatch:
 * payment reference, amount and giro, amount and date, amount and name) for
 * an expense row. Owned by supplier-invoices; the file stays beside the
 * heuristics it runs.
 *
 * ALWAYS a suggestion (potential_supplier_invoice_id), never a hard link.
 * supplier_invoice_id is reserved for completed matches: the match route
 * books the payment voucher when it sets it. A sync-time hard link booked
 * nothing, left the invoice open, and then BLOCKED the match route
 * (MATCH_SI_TX_ALREADY_LINKED), stranding the transaction with no path to a
 * payment voucher.
 */
import type { IngestMatcher } from '@/lib/transactions/ingest-matcher'
import { findSupplierInvoiceMatch } from './supplier-invoice-matching'

export const supplierInvoiceIngestMatcher: IngestMatcher = {
  id: 'supplier-invoice',
  order: 320,
  module: 'supplier-invoices',
  direction: 'expense',
  onReread: true,
  async match(batch, _state, { tx, reread }) {
    if (batch.pools.supplierInvoices.length === 0) return 'none'
    const match = findSupplierInvoiceMatch(tx, batch.pools.supplierInvoices)
    if (!match || batch.claims.has('supplier_invoice', match.supplierInvoice.id)) return 'none'

    const invoiceId = match.supplierInvoice.id
    const strong = match.confidence >= 0.85 && !match.ambiguous
    const existingHint = tx.potential_supplier_invoice_id ?? null
    if (reread && existingHint && (existingHint === invoiceId || !strong)) {
      // The hint stands. A strong match for the invoice it names still
      // drains the pool, as a new row's would.
      if (!strong) return 'none'
      batch.pools.supplierInvoices = batch.pools.supplierInvoices.filter((inv) => inv.id !== invoiceId)
      batch.claims.add('supplier_invoice', invoiceId)
      return 'explained'
    }
    await batch.supabase
      .from('transactions')
      .update({ potential_supplier_invoice_id: invoiceId })
      .eq('id', tx.id)

    await batch.logMatch(tx.id, 'auto_suggested', {
      supplierInvoiceId: invoiceId,
      matchConfidence: match.confidence,
      matchMethod: match.matchMethod,
    })

    if (strong) {
      // High-confidence unambiguous hit: drain the pool so the next
      // transaction can't claim the same invoice, and skip the mapping
      // engine: auto-categorization would create an orphaned journal entry
      // that conflicts with the eventual payment booking.
      batch.pools.supplierInvoices = batch.pools.supplierInvoices.filter((inv) => inv.id !== invoiceId)
      batch.claims.add('supplier_invoice', invoiceId)
      batch.result.auto_matched_invoices++
      return 'explained'
    }
    // Lower confidence (0.70-0.85) or ambiguous: tentative, do NOT drain the
    // pool; the next matchers and the mapping rule still run.
    return 'hinted'
  },
}
