import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailService } from '@/lib/email/service'
import type { Logger } from '@/lib/logger'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailSubject,
  generateInvoiceEmailText,
} from '@/lib/email/invoice-templates'
import { computeSHA256, downloadDocumentObject } from '@/lib/core/documents/document-service'
import {
  EMAIL_PATTERN,
  exceedsInvoiceEmailRecipientLimit,
  invoiceEmailRecipientCount,
  resolveInvoiceEmailRecipients,
  resolveInvoiceReplyTo,
} from '@/lib/invoices/email-recipients'
import { loadInvoiceEmailAttachments } from '@/lib/invoices/invoice-attachments'
import { invoiceLacksCustomer } from '@/lib/invoices/invoice-customer'
import {
  InvoiceDeliverySnapshotError,
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
} from '@/lib/invoices/invoice-deliveries'
import { findArchivedInvoiceDelivery, type InvoicePdfDelivery } from '@/lib/invoices/invoice-pdf-source'
import { isInvoiceResendEligible } from '@/lib/invoices/resend-eligibility'
import type { CompanySettings, Customer, Invoice } from '@/types'

export type ResendInvoiceResult =
  | {
      ok: true
      deliveryId: string
      messageId?: string
      recipientCounts: { to: number; cc: number }
      trackingWarning?: string
    }
  | { ok: false; code: string; details?: Record<string, unknown> }

function fail(code: string, details?: Record<string, unknown>): ResendInvoiceResult {
  return details ? { ok: false, code, details } : { ok: false, code }
}

/**
 * Email an issued invoice to the customer again (crm#1339): "Skicka igen".
 *
 * The attachment is the exact file the customer was first emailed, read from
 * the archive and checked against its stored SHA-256, never a re-render: a
 * re-render reads today's invoice, customer and company rows and can be a
 * different document under the same number (lib/invoices/invoice-pdf-source.ts).
 * An invoice that Accounted never emailed has no such file and is refused;
 * its PDF download is the way to hand it over.
 *
 * Same recipients as the invoice send (the customer, the company's and the
 * customer's fixed CC and BCC) and the files the invoice carries. The subject
 * is marked "Kopia:" and the message says when the original went out. The
 * send is recorded as a new email delivery pointing at the archived document.
 * Nothing else changes: no status, no sent_at, no verifikat, no event, and no
 * reminder (a påminnelse is its own flow with its own fee and wording).
 */
export async function resendInvoiceEmail(args: {
  supabase: SupabaseClient
  emailService: EmailService
  companyId: string
  userId: string
  userEmail?: string | null
  invoiceId: string
  log: Logger
}): Promise<ResendInvoiceResult> {
  const { supabase, emailService, companyId, userId, invoiceId, log } = args

  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (invoiceError || !invoice) return fail('INVOICE_NOT_FOUND')

  if (!isInvoiceResendEligible(invoice as Invoice)) {
    return fail('INVOICE_RESEND_NOT_ELIGIBLE', { currentStatus: (invoice as Invoice).status })
  }

  if (invoiceLacksCustomer(invoice)) return fail('INVOICE_CUSTOMER_MISSING')
  const customer = invoice.customer as Customer
  if (!customer.email?.trim() || !EMAIL_PATTERN.test(customer.email.trim())) {
    return fail('INVOICE_SEND_NO_CUSTOMER_EMAIL', { customerId: customer.id })
  }

  // The same history the detail page reads, newest first.
  const { data: deliveries, error: deliveriesError } = await supabase.rpc(
    'list_invoice_delivery_summaries',
    { p_company_id: companyId, p_invoice_id: invoiceId },
  )
  if (deliveriesError) {
    log.error('resend: failed to read the delivery history', deliveriesError)
    return fail('INVOICE_RESEND_ARCHIVE_UNAVAILABLE')
  }
  const archived = findArchivedInvoiceDelivery(
    (deliveries ?? []) as Array<InvoicePdfDelivery & { attachment_filename: string | null }>,
  )
  if (!archived) return fail('INVOICE_RESEND_NO_ARCHIVED_COPY')

  const { data: document, error: documentError } = await supabase
    .from('document_attachments')
    .select('id, file_name, storage_path, sha256_hash')
    .eq('id', archived.document_attachment_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (documentError || !document) {
    log.error('resend: archived invoice PDF row not readable', {
      documentId: archived.document_attachment_id,
      reason: documentError?.message,
    })
    return fail('INVOICE_RESEND_ARCHIVE_UNAVAILABLE')
  }

  const { blob } = await downloadDocumentObject(supabase, document.storage_path, companyId)
  if (!blob) {
    log.error('resend: archived invoice PDF could not be downloaded', { documentId: document.id })
    return fail('INVOICE_RESEND_ARCHIVE_UNAVAILABLE')
  }
  const bytes = await blob.arrayBuffer()
  // What leaves must be byte for byte what the archive recorded as sent.
  if ((await computeSHA256(bytes)) !== document.sha256_hash) {
    log.error('resend: archived invoice PDF does not match its stored checksum', {
      documentId: document.id,
    })
    return fail('INVOICE_RESEND_ARCHIVE_UNAVAILABLE')
  }

  const { data: company, error: companyError } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single()
  if (companyError || !company) return fail('INVOICE_SEND_COMPANY_SETTINGS_MISSING')

  const recipients = resolveInvoiceEmailRecipients({
    to: customer.email,
    configuredCc: company.invoice_email_cc_addresses,
    configuredBcc: company.invoice_email_bcc_addresses,
    customerCc: customer.invoice_email_cc_addresses,
    customerBcc: customer.invoice_email_bcc_addresses,
  })
  if (recipients.to.length === 0) {
    return fail('INVOICE_SEND_NO_CUSTOMER_EMAIL', { customerId: customer.id })
  }
  if (exceedsInvoiceEmailRecipientLimit(recipients)) {
    return fail('INVOICE_SEND_TOO_MANY_RECIPIENTS', {
      recipient_count: invoiceEmailRecipientCount(recipients),
    })
  }

  // Every email delivery of an invoice carries its files (crm#1269).
  const extraAttachments = await loadInvoiceEmailAttachments(supabase, companyId, invoiceId)
  if (!extraAttachments.ok) return fail(extraAttachments.code)

  let deliveryId: string
  try {
    deliveryId = await reserveInvoiceDelivery({ supabase, companyId, userId, invoiceId })
  } catch (err) {
    log.error('resend: failed to reserve the delivery', err as Error)
    return fail('INVOICE_SEND_SNAPSHOT_FAILED', {
      retryable: err instanceof InvoiceDeliverySnapshotError,
    })
  }

  const replyTo = resolveInvoiceReplyTo(company as CompanySettings, args.userEmail)
  const emailData = {
    invoice: invoice as Invoice,
    customer,
    company: company as CompanySettings,
    replyTo,
    copyOf: { sentAt: archived.sent_at },
  }

  let result
  try {
    result = await sendTrackedInvoiceEmail({
      supabase,
      emailService,
      companyId,
      userId,
      invoiceId,
      deliveryId,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject: generateInvoiceEmailSubject(emailData),
      html: generateInvoiceEmailHtml(emailData),
      text: generateInvoiceEmailText(emailData),
      replyTo,
      fromName: company.company_name,
      from: await resolveInvoiceSender(supabase, companyId, company.company_name),
      filename: archived.attachment_filename || document.file_name,
      pdfBuffer: Buffer.from(bytes),
      extraAttachments: extraAttachments.value,
      archivedDocument: { id: document.id, sha256Hash: document.sha256_hash },
    })
  } catch (err) {
    log.error('resend: failed to persist the delivery snapshot', err as Error)
    return fail('INVOICE_SEND_SNAPSHOT_FAILED', {
      retryable: err instanceof InvoiceDeliverySnapshotError,
    })
  }

  if (!result.success) {
    log.error('resend: email provider failed', new Error(result.error || 'Unknown'), {
      deliveryId: result.deliveryId,
      trackingWarning: result.trackingWarning,
    })
    return fail('INVOICE_SEND_PROVIDER_FAILED', { retryable: true })
  }

  if (result.trackingWarning) {
    log.warn('resend: delivery snapshot not finalised', {
      deliveryId: result.deliveryId,
      warning: result.trackingWarning,
    })
  }

  log.info('invoice resent', {
    deliveryId: result.deliveryId,
    messageId: result.messageId,
    originalDeliveryId: archived.id,
    recipientCounts: { to: recipients.to.length, cc: recipients.cc.length },
  })

  return {
    ok: true,
    deliveryId: result.deliveryId,
    messageId: result.messageId,
    recipientCounts: { to: recipients.to.length, cc: recipients.cc.length },
    ...(result.trackingWarning ? { trackingWarning: result.trackingWarning } : {}),
  }
}
