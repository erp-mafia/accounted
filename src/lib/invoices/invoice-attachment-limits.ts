/**
 * Limits on the files emailed with an invoice after its PDF (crm#1269). A
 * module of its own so the send dialog can read them without the server-side
 * document service that lib/invoices/invoice-attachments.ts imports.
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
