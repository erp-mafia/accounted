import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import {
  prepareInvoicePdfRender,
  buildSwishQrDataUrl,
  buildPaymentLinkQrDataUrl,
} from '@/lib/invoices/pdf-render-helpers'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import {
  generatePaymentConfirmationEmailHtml,
  generatePaymentConfirmationEmailSubject,
  generatePaymentConfirmationEmailText,
} from '@/lib/email/invoice-templates'
import { paymentConfirmationPdfFilename } from '@/lib/invoices/pdf-filename'
import { isPaymentConfirmationEligible } from '@/lib/invoices/payment-confirmation'
import {
  EMAIL_PATTERN,
  exceedsInvoiceEmailRecipientLimit,
  invoiceEmailRecipientCount,
  resolveInvoiceEmailRecipients,
} from '@/lib/invoices/email-recipients'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/send-payment-confirmation (#1693)
 *
 * Emails the customer a betalningsbekräftelse: the paid re-render of the
 * faktura (BETALD stamp, "Betalt / Att betala: 0") attached to a short
 * confirmation mail. Same email service, recipients and branding as the
 * invoice send, but deliberately none of its side effects: the invoice
 * status, sent_at, journal entries and the delivery history are untouched.
 * The delivery history records what was sent as the invoice, and a later
 * confirmation must never be mistaken for that file, so this route logs the
 * send and writes nothing to the database.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.send_payment_confirmation',
  async (_request, { user, supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const opLog = log.child({ invoiceId: id })

    // The sandbox must never deliver a real email to a real customer.
    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked

    const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.email_send)
    if (capBlocked) return capBlocked

    const emailService = getEmailService()
    if (!emailService.isConfigured()) {
      return errorResponseFromCode('INVOICE_SEND_EMAIL_NOT_CONFIGURED', opLog, { requestId })
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select(`
        *,
        customer:customers(*),
        items:invoice_items(*)
      `)
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (!isPaymentConfirmationEligible(invoice as Invoice)) {
      return errorResponseFromCode('INVOICE_PAYMENT_CONFIRMATION_NOT_PAID', opLog, {
        requestId,
        details: { currentStatus: (invoice as Invoice).status },
      })
    }

    const customer = invoice.customer as Customer
    if (!customer.email?.trim() || !EMAIL_PATTERN.test(customer.email.trim())) {
      return errorResponseFromCode('INVOICE_SEND_NO_CUSTOMER_EMAIL', opLog, {
        requestId,
        details: { customerId: customer.id },
      })
    }

    const { data: company, error: companyError } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (companyError || !company) {
      return errorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', opLog, { requestId })
    }

    // The paid copy still prints the payment block, so it needs the same
    // account data the invoice render does.
    const paymentAccountRequired = invoiceRequiresPaymentAccount(invoice as Invoice)
    if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, invoice as Invoice)) {
      return errorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', opLog, {
        requestId,
        details: { currency: (invoice as Invoice).currency },
      })
    }

    // Same fixed routing as the invoice send (company/customer CC and BCC,
    // the company's own copy). No per-request recipients: this is a
    // one-click resend of a document the customer already has a right to.
    const recipients = resolveInvoiceEmailRecipients({
      to: customer.email,
      configuredCc: company.invoice_email_cc_addresses,
      configuredBcc: company.invoice_email_bcc_addresses,
      customerCc: customer.invoice_email_cc_addresses,
      customerBcc: customer.invoice_email_bcc_addresses,
      legacyCc: company.email || user.email,
    })
    if (recipients.to.length === 0) {
      return errorResponseFromCode('INVOICE_SEND_NO_CUSTOMER_EMAIL', opLog, {
        requestId,
        details: { customerId: customer.id },
      })
    }
    if (exceedsInvoiceEmailRecipientLimit(recipients)) {
      return errorResponseFromCode('INVOICE_SEND_TOO_MANY_RECIPIENTS', opLog, {
        requestId,
        details: { recipient_count: invoiceEmailRecipientCount(recipients) },
      })
    }

    const items = (invoice.items as InvoiceItem[]).sort((a, b) => a.sort_order - b.sort_order)

    let pdfBuffer: Buffer
    try {
      const { branding, company: renderCompany } = await prepareInvoicePdfRender(
        company as CompanySettings,
        (invoice as Invoice).currency,
        { paymentAccountRequired },
      )
      const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, invoice as Invoice)
      const paymentLinkQrDataUrl = await buildPaymentLinkQrDataUrl(invoice as Invoice)
      pdfBuffer = await renderToBuffer(
        InvoicePDF({
          invoice: invoice as Invoice,
          customer,
          items,
          company: renderCompany,
          branding,
          swishQrDataUrl,
          paymentLinkQrDataUrl,
        }),
      )
    } catch (err) {
      opLog.error('payment confirmation PDF render failed', err as Error)
      return errorResponseFromCode('INVOICE_PDF_RENDER_FAILED', opLog, { requestId })
    }

    const emailData = {
      invoice: invoice as Invoice,
      customer,
      company: company as CompanySettings,
    }
    const filename = paymentConfirmationPdfFilename(invoice.invoice_number)

    const result = await emailService.sendEmail({
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject: generatePaymentConfirmationEmailSubject(emailData),
      html: generatePaymentConfirmationEmailHtml(emailData),
      text: generatePaymentConfirmationEmailText(emailData),
      replyTo: company.email || undefined,
      fromName: company.company_name,
      from: await resolveInvoiceSender(supabase, companyId, company.company_name),
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    })

    if (!result.success) {
      opLog.error(
        'email provider failed to send payment confirmation',
        new Error(result.error || 'Unknown'),
      )
      return errorResponseFromCode('INVOICE_SEND_PROVIDER_FAILED', opLog, {
        requestId,
        details: { retryable: true },
      })
    }

    // The delivery history has no kind column for confirmations, and writing
    // one there as an email delivery would make it the "sent invoice" to the
    // archive logic. Logged instead; a typed history entry is a follow-up.
    opLog.info('payment confirmation sent', {
      userId: user.id,
      invoiceNumber: invoice.invoice_number,
      messageId: result.messageId,
      recipientCounts: {
        to: recipients.to.length,
        cc: recipients.cc.length,
      },
    })

    return NextResponse.json(
      {
        success: true,
        message: `Betalningsbekräftelsen har skickats till ${customer.email}`,
        messageId: result.messageId,
        recipient_counts: {
          to: recipients.to.length,
          cc: recipients.cc.length,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
  { requireWrite: true },
)
