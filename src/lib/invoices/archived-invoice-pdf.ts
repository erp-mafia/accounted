import type { SupabaseClient } from '@supabase/supabase-js'
import { computeSHA256, downloadDocumentObject } from '@/lib/core/documents/document-service'
import { findArchivedInvoiceDelivery, type InvoicePdfDelivery } from '@/lib/invoices/invoice-pdf-source'
import type { Logger } from '@/lib/logger'

/**
 * The invoice PDF exactly as the customer was first emailed it: the archived
 * copy of the latest completed email delivery, checked against its stored
 * SHA-256. Never a re-render: a re-render reads today's invoice, customer and
 * company rows and can be a different document under the same number
 * (lib/invoices/invoice-pdf-source.ts).
 *
 * Used by "Skicka igen" (resend-invoice.ts) and by the reminder email, which
 * attaches the same file. An invoice Accounted never emailed has no archived
 * copy.
 */

export interface ArchivedInvoicePdf {
  delivery: { id: string; sent_at: string | null }
  document: { id: string; sha256Hash: string }
  filename: string
  bytes: ArrayBuffer
}

export type ArchivedInvoicePdfResult =
  | { ok: true; value: ArchivedInvoicePdf }
  | { ok: false; code: 'INVOICE_RESEND_NO_ARCHIVED_COPY' | 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' }

export async function loadArchivedInvoicePdf(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  log: Logger,
): Promise<ArchivedInvoicePdfResult> {
  const unavailable = { ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' } as const

  // The same history the detail page reads, newest first.
  const { data: deliveries, error: deliveriesError } = await supabase.rpc('list_invoice_delivery_summaries', {
    p_company_id: companyId,
    p_invoice_id: invoiceId,
  })
  if (deliveriesError) {
    log.error('archived invoice PDF: failed to read the delivery history', deliveriesError)
    return unavailable
  }
  const archived = findArchivedInvoiceDelivery(
    (deliveries ?? []) as Array<InvoicePdfDelivery & { attachment_filename: string | null }>,
  )
  if (!archived) return { ok: false, code: 'INVOICE_RESEND_NO_ARCHIVED_COPY' }

  const { data: document, error: documentError } = await supabase
    .from('document_attachments')
    .select('id, file_name, storage_path, sha256_hash')
    .eq('id', archived.document_attachment_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (documentError || !document) {
    log.error('archived invoice PDF: row not readable', {
      documentId: archived.document_attachment_id,
      reason: documentError?.message,
    })
    return unavailable
  }

  const { blob } = await downloadDocumentObject(supabase, document.storage_path, companyId)
  if (!blob) {
    log.error('archived invoice PDF: could not be downloaded', { documentId: document.id })
    return unavailable
  }
  const bytes = await blob.arrayBuffer()
  // What leaves must be byte for byte what the archive recorded as sent.
  if ((await computeSHA256(bytes)) !== document.sha256_hash) {
    log.error('archived invoice PDF: does not match its stored checksum', { documentId: document.id })
    return unavailable
  }

  return {
    ok: true,
    value: {
      delivery: { id: archived.id, sent_at: archived.sent_at },
      document: { id: document.id, sha256Hash: document.sha256_hash },
      filename: archived.attachment_filename || document.file_name,
      bytes,
    },
  }
}
