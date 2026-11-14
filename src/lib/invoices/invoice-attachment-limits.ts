import { isShrinkableImage } from '@/lib/documents/upload-size'
import { isAllowedDocumentFile } from '@/lib/documents/upload-types'
import type { EditorChannel } from '@/lib/invoices/editor/channel'

/**
 * Limits on the files emailed with an invoice after its PDF (crm#1269), and
 * when a send step offers them. A module of its own so the send dialogs can
 * read them without the server-side document service that
 * lib/invoices/invoice-attachments.ts imports.
 */

/** At most this many files ride along with one invoice. */
export const MAX_INVOICE_ATTACHMENTS = 10

/**
 * Resend, the hosted email provider: "Emails can be no larger than 40MB
 * (including attachments after Base64 encoding)". Base64 turns 3 bytes into
 * 4, so 25 MB of files is 33.4 MB on the wire, which leaves room for the
 * invoice PDF (at most 0.5 MB among the invoices emailed on production by
 * 2026-10-16), the HTML and text body and the MIME headers.
 */
export const MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024

/**
 * The largest single file that can be attached (#79): the archive's own
 * ceiling (MAX_DOCUMENT_SIZE in the document service) on every deployment. On
 * hosted a file over the platform's request-body cap goes straight to Storage
 * (postDocumentForm), so that cap no longer decides.
 */
export const MAX_INVOICE_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024

/**
 * Peppol carries the files inside the e-faktura itself, each base64-encoded
 * in a cac:AdditionalDocumentReference (BIS Billing 3.0). PDF only: the
 * format every receiving system can show, the one consultants attach (a
 * tidrapport, a dagbok), and inside the BIS mimeCode list.
 */
export const PEPPOL_ATTACHMENT_MIME_TYPE = 'application/pdf'

/**
 * At most this much file data inside one e-faktura. Inline attachments should
 * stay under 10 MB even though AS4 allows 100 MB: many access points refuse
 * larger messages (swedish-e-invoicing skill, peppol-bis-billing.md). Base64
 * turns 5 MB into 6.7 MB, which leaves room under 10 MB for the invoice XML
 * and the staged delivery row that stores the whole message.
 */
export const MAX_PEPPOL_ATTACHMENTS_TOTAL_BYTES = 5 * 1024 * 1024

/**
 * What happens to a picked file before it is uploaded:
 *  - 'ok':        it fits as it is.
 *  - 'shrink':    a photo over the limit; the browser re-encodes it
 *                 (prepareDocumentUpload) and the limit applies to the result.
 *  - 'too_large': refused up front, naming the limit that applies.
 */
export type InvoiceAttachmentSizeVerdict = 'ok' | 'shrink' | 'too_large'

export function invoiceAttachmentSizeVerdict(
  file: { size: number; type: string },
  hosted: boolean,
): InvoiceAttachmentSizeVerdict {
  if (file.size <= MAX_INVOICE_ATTACHMENT_FILE_BYTES) return 'ok'
  return hosted && isShrinkableImage(file.type) ? 'shrink' : 'too_large'
}

/**
 * Whether a send step offers Bilagor (#79). One rule for every send step, the
 * invoice page's send dialogs and the editor's confirm alike, so one step
 * cannot offer the files while another hides them. An email carries them
 * after the PDF, and an e-faktura over Peppol inside the message (PDF only,
 * crm#1545); mark-sent, a Kivra or Billo mailbox and the PDF download do not.
 * Only while the set can still change: a draft, or a document the editor has
 * not saved yet (`status` null). The sandbox sends neither, and a plan
 * without email cannot email. The invoicing-only role does not reach the
 * attachment routes (lib/auth/invoicer-role.ts), so no step offers it files
 * that every request would refuse (for #206).
 */
export function offersInvoiceAttachments(input: {
  channel: EditorChannel | null
  status: string | null
  isSandbox: boolean
  canEmail: boolean
  invoicer?: boolean
}): boolean {
  if (input.invoicer) return false
  const carries = input.channel === 'peppol' || (input.channel === 'email' && input.canEmail)
  return carries && (input.status === null || input.status === 'draft') && !input.isSandbox
}

/** A file an e-faktura can carry: a PDF, by its stored or picked type or its name. */
export function isPeppolAttachmentFile(file: { type: string | null; name: string }): boolean {
  return file.type === PEPPOL_ATTACHMENT_MIME_TYPE || (!file.type && /\.pdf$/i.test(file.name))
}

/** Why a file cannot join an invoice's attachments; the same reasons the upload path names. */
export type InvoiceAttachmentRefusal = 'unsupported_type' | 'peppol_pdf_only' | 'too_large' | 'too_many' | 'total_too_large'

/**
 * Why a document already in the archive cannot join the invoice's attachments
 * (accounted#42: a wholesaler's invoice behind invoiced material), or null
 * when it fits. The checks the upload path makes on a picked file, in the same
 * order, read off the stored type, name and size; nothing is shrunk, the
 * stored file is what goes out. `current` is what the invoice already carries
 * plus what is picked so far.
 */
export function archivedAttachmentRefusal(
  doc: { file_name: string; mime_type: string | null; file_size_bytes: number | null },
  current: { count: number; bytes: number },
  channel: 'email' | 'peppol',
): InvoiceAttachmentRefusal | null {
  const file = { name: doc.file_name, type: doc.mime_type }
  if (!isAllowedDocumentFile(file)) return 'unsupported_type'
  const peppol = channel === 'peppol'
  if (peppol && !isPeppolAttachmentFile(file)) return 'peppol_pdf_only'
  const size = doc.file_size_bytes ?? 0
  if (size > MAX_INVOICE_ATTACHMENT_FILE_BYTES) return 'too_large'
  if (current.count + 1 > MAX_INVOICE_ATTACHMENTS) return 'too_many'
  const totalLimit = peppol ? MAX_PEPPOL_ATTACHMENTS_TOTAL_BYTES : MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES
  if (current.bytes + size > totalLimit) return 'total_too_large'
  return null
}

/** A file size as the attachment lists show it: KB under a megabyte, MB above, in the reader's locale. */
export function formatAttachmentSize(bytes: number | null, locale: string): string {
  if (bytes === null) return ''
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { maximumFractionDigits: 1 })
  if (bytes < 1024 * 1024) return `${number.format(Math.max(bytes / 1024, 0.1))} KB`
  return `${number.format(bytes / (1024 * 1024))} MB`
}
