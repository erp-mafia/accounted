import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PRIVATE_NO_STORE_HEADERS, privateNoStore } from '@/lib/api/private-no-store'
import { validateBody } from '@/lib/api/validate'
import { InvoiceEmailPreviewSchema } from '@/lib/api/schemas'
import { buildInvoicePreviewDraft, isPreviewPlaceholderCustomer } from '@/lib/invoices/preview-draft'
import { generateInvoiceEmailHtml, generateInvoiceEmailSubject } from '@/lib/email/invoice-templates'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import {
  EMAIL_PATTERN,
  resolveInvoiceEmailRecipients,
  resolveInvoiceReplyTo,
} from '@/lib/invoices/email-recipients'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * POST /api/invoices/preview-email
 *
 * The email the invoice editor's draft would be sent with, rendered by the
 * real invoice email template without saving or sending anything: the
 * customer's language, the company's email texts (Inställningar > Utskick)
 * and, when given, this send's own email_subject / email_body (the same
 * fields POST /api/invoices/{id}/send takes). The draft is built exactly as
 * the PDF preview builds it (lib/invoices/preview-draft.ts), so the two
 * state the same amount and payment details.
 *
 * Returns { data: { subject, html, from, reply_to, to, cc, missing } }:
 *  - from: the sender's display name, and its address when the company
 *    sends from its own verified domain (null = the platform address);
 *  - reply_to: where a reply lands (null = the template leaves out the
 *    "reply to this email" line);
 *  - to / cc: the customer's address and the fixed copies (company and
 *    customer card). Per-send extra copies and BCC are not shown here;
 *  - missing: what the draft still lacks (customer, rows, payee).
 */
export const POST = withRouteContext('invoice.preview_email', async (request, {
  supabase,
  user,
  companyId,
  log,
  requestId,
}) => {
  const validation = await validateBody(request, InvoiceEmailPreviewSchema, { log, operation: 'invoice.preview_email' })
  if (!validation.success) return privateNoStore(validation.response)
  const { email_subject, email_body, ...draftInput } = validation.data

  const built = await buildInvoicePreviewDraft({
    supabase,
    companyId,
    userId: user.id,
    input: draftInput,
  })
  if (!built.ok) {
    return privateNoStore(errorResponseFromCode(built.code, log, { requestId, details: built.details }))
  }
  const { draft } = built
  const { company, customer } = draft

  const replyTo = resolveInvoiceReplyTo(company, user.email) ?? null
  const emailData = {
    // The template prints the number as given: a draft without a predicted
    // number shows none rather than the word "null".
    invoice: { ...draft.invoice, invoice_number: draft.invoice.invoice_number ?? '' },
    customer,
    company,
    replyTo,
    overrides: { subject: email_subject, body: email_body },
  }

  // The sample customer of a draft without one has no real address.
  const customerEmail = isPreviewPlaceholderCustomer(customer) ? null : customer.email?.trim() || null
  const recipients = resolveInvoiceEmailRecipients({
    to: customerEmail && EMAIL_PATTERN.test(customerEmail) ? [customerEmail] : [],
    configuredCc: company.invoice_email_cc_addresses,
    customerCc: customer.invoice_email_cc_addresses,
  })
  const sender = await resolveInvoiceSender(supabase, companyId, company.company_name)

  return NextResponse.json(
    {
      data: {
        subject: generateInvoiceEmailSubject(emailData),
        html: generateInvoiceEmailHtml(emailData),
        from: { name: sender?.name ?? company.company_name, address: sender?.address ?? null },
        reply_to: replyTo,
        to: recipients.to,
        cc: recipients.cc,
        missing: draft.missing,
      },
    },
    { headers: PRIVATE_NO_STORE_HEADERS },
  )
})
