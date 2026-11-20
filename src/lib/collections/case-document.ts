import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { COLLECTIONS_MAX_DOCUMENT_CHARS } from '@accounted/connect-contract'
import { downloadDocumentObject, uploadDocument } from '@/lib/core/documents/document-service'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import { invoiceRequiresPaymentAccount } from '@/lib/cash-accounts/invoice-payment-accounts'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

/**
 * The invoice PDF that goes to the collections provider with a handover.
 *
 * The customer got a document; the provider should see that one. So the
 * archived PDF of the latest successful email send is preferred, byte for
 * byte. An invoice sent another way (marked sent, Peppol, imported) has no
 * archived send, so its PDF is rendered once and archived as a system
 * document (no extraction): the case then refers to that archived copy, and
 * a timed-out handover is retried with exactly the same bytes, which the
 * idempotent call at Connect requires.
 */

export interface HandoverDocument {
  documentId: string
  filename: string
  sha256: string
  base64: string
}

export class HandoverDocumentError extends Error {
  constructor(
    readonly code: 'COLLECTION_DOCUMENT_UNAVAILABLE' | 'COLLECTION_DOCUMENT_TOO_LARGE' | 'COLLECTION_DOCUMENT_CHANGED',
    message: string,
  ) {
    super(message)
    this.name = 'HandoverDocumentError'
  }
}

function toDocument(documentId: string, filename: string, bytes: Uint8Array): HandoverDocument {
  const base64 = Buffer.from(bytes).toString('base64')
  if (base64.length > COLLECTIONS_MAX_DOCUMENT_CHARS) {
    throw new HandoverDocumentError('COLLECTION_DOCUMENT_TOO_LARGE', `invoice PDF is ${base64.length} base64 characters`)
  }
  return { documentId, filename, sha256: createHash('sha256').update(bytes).digest('hex'), base64 }
}

/** Read an archived PDF and check it is still the bytes that were recorded. */
export async function readArchivedDocument(
  db: SupabaseClient,
  companyId: string,
  documentId: string,
  expectedSha256?: string,
): Promise<HandoverDocument> {
  const { data, error } = await db
    .from('document_attachments')
    .select('id, storage_path, file_name, sha256_hash')
    .eq('company_id', companyId)
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw new Error(`document_attachments lookup failed: ${error.message}`)
  const row = data as { id: string; storage_path: string; file_name: string; sha256_hash: string } | null
  if (!row) throw new HandoverDocumentError('COLLECTION_DOCUMENT_UNAVAILABLE', 'archived invoice PDF not found')
  const { blob, error: downloadError } = await downloadDocumentObject(db, row.storage_path, companyId)
  if (!blob) {
    throw new HandoverDocumentError('COLLECTION_DOCUMENT_UNAVAILABLE', `archived invoice PDF unreadable: ${downloadError?.message ?? 'no data'}`)
  }
  const document = toDocument(row.id, row.file_name, new Uint8Array(await blob.arrayBuffer()))
  if (document.sha256 !== row.sha256_hash || (expectedSha256 && document.sha256 !== expectedSha256)) {
    throw new HandoverDocumentError('COLLECTION_DOCUMENT_CHANGED', 'archived invoice PDF does not match its recorded hash')
  }
  return document
}

async function latestSentDocumentId(db: SupabaseClient, companyId: string, invoiceId: string): Promise<string | null> {
  const { data, error } = await db
    .from('invoice_deliveries')
    .select('document_attachment_id, sent_at')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .eq('status', 'sent')
    .not('document_attachment_id', 'is', null)
    .order('sent_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`invoice_deliveries lookup failed: ${error.message}`)
  return ((data ?? []) as { document_attachment_id: string | null }[])[0]?.document_attachment_id ?? null
}

async function renderAndArchive(
  db: SupabaseClient,
  companyId: string,
  invoiceId: string,
  userId: string,
): Promise<HandoverDocument> {
  const [{ data: invoice, error: invoiceError }, { data: settings, error: settingsError }] = await Promise.all([
    db
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('company_id', companyId)
      .eq('id', invoiceId)
      .maybeSingle(),
    db.from('company_settings').select('*').eq('company_id', companyId).maybeSingle(),
  ])
  if (invoiceError) throw new Error(`invoice lookup failed: ${invoiceError.message}`)
  if (settingsError) throw new Error(`company_settings lookup failed: ${settingsError.message}`)
  if (!invoice || !settings || !(invoice as { customer?: unknown }).customer) {
    throw new HandoverDocumentError('COLLECTION_DOCUMENT_UNAVAILABLE', 'invoice or company settings missing for the PDF')
  }
  const company = settings as CompanySettings
  const inv = invoice as Invoice & { customer: Customer; items: InvoiceItem[] | null }
  // An issued invoice renders as sent: never stamped as a draft.
  const renderable: Invoice = { ...inv, status: 'sent' }
  const items = (inv.items ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
  // The one render entry point: the same payee, branding and payment QR code
  // as every other surface that prints this invoice.
  const { buffer } = await renderInvoicePdfBuffer({
    invoice: renderable,
    customer: inv.customer,
    items,
    company,
    paymentAccountRequired: invoiceRequiresPaymentAccount(renderable),
    payee: renderable.payment_details ?? null,
  })
  const filename = invoicePdfFilename({
    companyName: company.company_name,
    customerName: inv.customer.name,
    invoiceNumber: inv.invoice_number,
    invoiceId: inv.id,
    invoiceDate: inv.invoice_date,
    documentType: inv.document_type,
    isCreditNote: false,
  })
  const bytes = new Uint8Array(buffer)
  const archived = await uploadDocument(
    db,
    userId,
    companyId,
    { name: filename, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: 'application/pdf' },
    { upload_source: 'system', extractionOwner: 'none' },
  )
  return toDocument(archived.id, archived.file_name, bytes)
}

/** The PDF for a new handover: the archived send, else a rendered and archived copy. */
export async function resolveHandoverDocument(
  db: SupabaseClient,
  input: { companyId: string; invoiceId: string; userId: string },
): Promise<HandoverDocument> {
  const sentId = await latestSentDocumentId(db, input.companyId, input.invoiceId)
  if (sentId) {
    try {
      return await readArchivedDocument(db, input.companyId, sentId)
    } catch (err) {
      // A send whose archive cannot be read falls back to a fresh copy; a
      // copy that fails its own hash check is a real problem and surfaces.
      if (!(err instanceof HandoverDocumentError) || err.code !== 'COLLECTION_DOCUMENT_UNAVAILABLE') throw err
    }
  }
  return renderAndArchive(db, input.companyId, input.invoiceId, input.userId)
}
