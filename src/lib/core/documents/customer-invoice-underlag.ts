import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { firstAnchorableEntry } from './supplier-invoice-underlag'

const log = createLogger('customer-invoice-underlag')

/**
 * Anchor a customer invoice's archived PDF to one of the invoice's own posted
 * verifikat when the PDF is currently floating
 * (document_attachments.journal_entry_id IS NULL).
 *
 * Why this exists (support case 2026-09-22): a kontantmetoden company linked
 * a sent invoice to the bank verifikat that booked its payment ("Koppla
 * befintlig verifikation"). The link advanced the invoice, but the verifikat
 * showed no underlag, so the user downloaded the invoice PDF and uploaded it
 * again although Accounted already held it. Under kontantmetoden there is no
 * registration verifikat for the send to hang the PDF on, so the archived copy
 * (invoice_deliveries.document_attachment_id: the exact file the customer
 * received) stays floating until something anchors it, and nothing did.
 *
 * Only the archived delivery copy is ever anchored. A re-render from today's
 * rows is a different document (see lib/invoices/invoice-pdf-source.ts) and
 * an anchored document can never be deleted again, so an invoice without an
 * archived copy is left alone.
 *
 * Anchoring is strictly an improvement: the document goes behind the WORM
 * deletion guard and the verifikat carries its underlag (BFL 5 kap 7 §). The
 * immutability trigger allows NULL -> uuid; an already-anchored document is
 * never moved, so repeating the call (or linking a second payment) is a no-op.
 * Nothing is written to journal_entries or its lines.
 *
 * Preference order mirrors the supplier side: the registration verifikat
 * (faktureringsmetoden), then payment verifikat oldest first.
 *
 * Returns the journal entry id the document was anchored to, or null when
 * nothing needed doing. Never throws: every caller runs after a committed
 * link, so a failure here must be logged, not surfaced.
 */
export async function anchorCustomerInvoiceDocument(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<string | null> {
  try {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('id, journal_entry_id')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!invoice) return null

    // The newest completed send that archived its file. A 'marked_sent'
    // delivery never holds a document (the CHECK constraint forbids it).
    const { data: delivery } = await supabase
      .from('invoice_deliveries')
      .select('document_attachment_id')
      .eq('company_id', companyId)
      .eq('invoice_id', invoiceId)
      .eq('status', 'sent')
      .not('document_attachment_id', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const documentId = (delivery as { document_attachment_id?: string | null } | null)
      ?.document_attachment_id
    if (!documentId) return null

    const { data: document } = await supabase
      .from('document_attachments')
      .select('id, journal_entry_id, is_current_version')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle()

    const doc = document as
      | { id: string; journal_entry_id: string | null; is_current_version: boolean }
      | null
    // Already anchored (the faktureringsmetoden case: the registration
    // verifikat holds it), superseded, or gone: leave it alone.
    if (!doc || doc.journal_entry_id || doc.is_current_version !== true) return null

    const candidates: string[] = []
    const push = (id: string | null | undefined) => {
      if (id && !candidates.includes(id)) candidates.push(id)
    }
    push((invoice as { journal_entry_id: string | null }).journal_entry_id)

    const { data: paymentRows } = await supabase
      .from('invoice_payments')
      .select('journal_entry_id, payment_date')
      .eq('company_id', companyId)
      .eq('invoice_id', invoiceId)
      .not('journal_entry_id', 'is', null)
      .order('payment_date', { ascending: true })
    for (const row of (paymentRows ?? []) as { journal_entry_id: string | null }[]) {
      push(row.journal_entry_id)
    }

    const entryId = await firstAnchorableEntry(
      supabase,
      companyId,
      candidates,
      'customer invoice',
      { invoiceId },
    )
    if (!entryId) {
      log.warn('customer invoice document is floating but no verifikat can anchor it', {
        companyId,
        invoiceId,
        documentId: doc.id,
      })
      return null
    }

    const { data: updatedRows, error } = await supabase
      .from('document_attachments')
      .update({ journal_entry_id: entryId })
      .eq('id', doc.id)
      .eq('company_id', companyId)
      // Concurrency guard: never steal a document another writer anchored
      // since the read above.
      .is('journal_entry_id', null)
      .eq('is_current_version', true)
      .select('id')

    if (error) {
      log.warn('failed to anchor customer invoice document to verifikat', {
        companyId,
        invoiceId,
        documentId: doc.id,
        journalEntryId: entryId,
        reason: error.message,
      })
      return null
    }
    if (!updatedRows || updatedRows.length === 0) {
      log.warn('anchor update matched no rows; customer invoice document left floating', {
        companyId,
        invoiceId,
        documentId: doc.id,
        journalEntryId: entryId,
      })
      return null
    }
    return entryId
  } catch (err) {
    log.warn('anchorCustomerInvoiceDocument threw', {
      companyId,
      invoiceId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
