import { isShrinkableImage } from '@/lib/documents/upload-size'
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
 * invoice page's send dialog and the editor's confirm alike, so one step
 * cannot offer the files while another hides them. Only an email carries
 * them (Peppol, mark-sent, a Kivra or Billo mailbox and the PDF download do
 * not), and only while the set can still change: a draft, or a document the
 * editor has not saved yet (`status` null). The sandbox sends no email, and a
 * plan without email cannot send one.
 */
export function offersInvoiceAttachments(input: {
  channel: EditorChannel | null
  status: string | null
  isSandbox: boolean
  canEmail: boolean
}): boolean {
  return (
    input.channel === 'email' &&
    (input.status === null || input.status === 'draft') &&
    !input.isSandbox &&
    input.canEmail
  )
}
