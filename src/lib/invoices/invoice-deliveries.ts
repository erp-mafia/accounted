import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailService, SendEmailOptions, SendEmailResult } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import { deleteDocument, uploadDocument } from '@/lib/core/documents/document-service'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { InvoiceDelivery } from '@/types'

const PDF_CONTENT_TYPE = 'application/pdf'

export class InvoiceDeliverySnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvoiceDeliverySnapshotError'
  }
}

export interface TrackedInvoiceEmailInput {
  supabase: SupabaseClient
  emailService: EmailService
  companyId: string
  userId: string
  invoiceId: string
  deliveryId: string
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string
  fromName?: string
  /** Company's own verified sender (resolveInvoiceSender); platform sender when absent. */
  from?: SendEmailOptions['from']
  subject: string
  html: string
  text: string
  filename: string
  pdfBuffer: Buffer
  /**
   * The invoice's own attachments (lib/invoices/invoice-attachments.ts),
   * emailed after the PDF in this order with their original file names.
   */
  extraAttachments?: NonNullable<SendEmailOptions['attachments']>
  /**
   * The archive already holds `pdfBuffer`: a resend of the file an earlier
   * delivery archived (crm#1339). The delivery then points at that document
   * instead of archiving a copy, and a failed send never deletes it.
   */
  archivedDocument?: { id: string; sha256Hash: string }
}

export interface TrackedInvoiceEmailResult extends SendEmailResult {
  deliveryId: string
  documentId: string
  trackingWarning?: 'finalize_failed' | 'failure_record_failed' | 'failure_cleanup_failed'
}

function addresses(value?: string | string[]): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Persist a reusable delivery attempt before allocating an invoice number.
 * The unique preparing row is also the concurrency lock for one invoice send.
 * The stateless service-role client is only transport for the service-only RPC:
 * the RPC re-authorizes userId as a writable member of companyId and scopes the
 * invoice row to the same company before it can write anything.
 */
export async function reserveInvoiceDelivery(args: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  invoiceId: string
}): Promise<string> {
  const { data, error } = await createServiceClient().rpc('reserve_invoice_delivery', {
    p_company_id: args.companyId,
    p_invoice_id: args.invoiceId,
    p_actor_user_id: args.userId,
  })

  if (!error && typeof data === 'string') return data

  throw new InvoiceDeliverySnapshotError(
    `Failed to reserve invoice delivery: ${error?.message || 'unknown error'}`,
  )
}

export async function sendTrackedInvoiceEmail(
  input: TrackedInvoiceEmailInput,
): Promise<TrackedInvoiceEmailResult> {
  const {
    supabase,
    emailService,
    companyId,
    userId,
    invoiceId,
    deliveryId,
    to,
    cc,
    bcc,
    replyTo,
    fromName,
    from,
    subject,
    html,
    text,
    filename,
    pdfBuffer,
    extraAttachments = [],
    archivedDocument,
  } = input

  // Only a document archived for this delivery is this delivery's to clean
  // up; a reused one belongs to the delivery that archived it.
  const ownsDocument = !archivedDocument
  const document = archivedDocument
    ? { id: archivedDocument.id, sha256_hash: archivedDocument.sha256Hash }
    : await uploadDocument(
        supabase,
        userId,
        companyId,
        {
          name: filename,
          buffer: new Uint8Array(pdfBuffer).buffer as ArrayBuffer,
          type: PDF_CONTENT_TYPE,
        },
        { upload_source: 'system' },
      )

  // These service-only RPCs re-authorize userId against companyId and bind
  // every transition to the reserved invoice, so no caller-supplied tenant or
  // actor identifier is trusted merely because this client bypasses RLS.
  const deliveryWriter = createServiceClient()
  const { data: capturedDeliveryId, error: deliveryError } = await deliveryWriter.rpc(
    'capture_invoice_delivery_payload',
    {
      p_delivery_id: deliveryId,
      p_company_id: companyId,
      p_invoice_id: invoiceId,
      p_actor_user_id: userId,
      p_to_addresses: addresses(to),
      p_cc_addresses: addresses(cc),
      p_bcc_addresses: addresses(bcc),
      p_reply_to: replyTo || null,
      p_from_name: fromName || null,
      p_subject: subject,
      p_body_text: text,
      p_body_html: html,
      p_document_attachment_id: document.id,
      p_attachment_filename: filename,
      p_attachment_content_type: PDF_CONTENT_TYPE,
      p_attachment_sha256: document.sha256_hash,
    },
  )

  if (deliveryError || capturedDeliveryId !== deliveryId) {
    if (ownsDocument) {
      try {
        await deleteDocument(supabase, companyId, document.id)
      } catch {
        // Best-effort cleanup only. The send must remain blocked even if the
        // unlinked archive cannot be removed after a snapshot insert failure.
      }
    }
    throw new InvoiceDeliverySnapshotError(
      `Failed to persist invoice delivery snapshot: ${deliveryError?.message || 'unknown error'}`,
    )
  }

  // Brand mail (WL-13): the invoice mail keeps the COMPANY as the displayed
  // sender exactly as today, but rides the brand's verified sender domain
  // when the company's team has one. No brand, or an unverified sender
  // domain, leaves the From header byte-identical to before.
  const brandSender = await getSenderForCompany(companyId)

  const emailOptions: SendEmailOptions = {
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    replyTo,
    fromName,
    ...(brandSender.fromAddress ? { fromAddress: brandSender.fromAddress } : {}),
    // The company's own verified sender wins over the brand address
    // (buildFromHeader gives `from` precedence).
    from,
    // The invoice PDF first, then the files the invoice carries.
    attachments: [
      {
        filename,
        content: pdfBuffer,
        contentType: PDF_CONTENT_TYPE,
      },
      ...extraAttachments,
    ],
  }
  const result = await emailService.sendEmail(emailOptions)

  if (!result.success) {
    const { data: failedDeliveryId, error: failureRecordError } = await deliveryWriter.rpc(
      'finalize_invoice_delivery',
      {
        p_delivery_id: deliveryId,
        p_company_id: companyId,
        p_actor_user_id: userId,
        p_status: 'failed',
        p_provider: result.provider || null,
        p_provider_message_id: null,
        p_error_code: 'provider_failed',
      },
    )

    const failureRecorded = !failureRecordError && failedDeliveryId === deliveryId
    let cleanupFailed = false
    if (failureRecorded && ownsDocument) {
      try {
        const cleanup = await deleteDocument(supabase, companyId, document.id)
        cleanupFailed = !cleanup.ok
      } catch {
        cleanupFailed = true
      }
    }

    return {
      ...result,
      deliveryId,
      documentId: document.id,
      ...(!failureRecorded
        ? { trackingWarning: 'failure_record_failed' as const }
        : cleanupFailed
          ? { trackingWarning: 'failure_cleanup_failed' as const }
          : {}),
    }
  }

  const { data: finalizedDeliveryId, error: finalizeError } = await deliveryWriter.rpc(
    'finalize_invoice_delivery',
    {
      p_delivery_id: deliveryId,
      p_company_id: companyId,
      p_actor_user_id: userId,
      p_status: 'sent',
      p_provider: result.provider || null,
      p_provider_message_id: result.messageId || null,
      p_error_code: null,
    },
  )

  // Delivery is irreversible once the provider succeeds. A failed terminal
  // transition is returned as a reconciliation warning; each caller still
  // advances the invoice to sent, and ordinary send routes reject non-drafts,
  // so a pending evidence row never becomes permission to send a duplicate.
  // Pending rows are outside the preparing-only reservation lock, so retained
  // evidence also cannot block a later explicitly authorized resend.
  const finalized = !finalizeError && finalizedDeliveryId === deliveryId
  return {
    ...result,
    deliveryId,
    documentId: document.id,
    ...(!finalized ? { trackingWarning: 'finalize_failed' as const } : {}),
  }
}

export async function recordManualInvoiceDelivery(args: {
  supabase: SupabaseClient
  companyId: string
  userId: string
  invoiceId: string
  sentAt?: string
}): Promise<InvoiceDelivery> {
  const { data, error } = await createServiceClient().rpc('record_manual_invoice_delivery', {
    p_company_id: args.companyId,
    p_invoice_id: args.invoiceId,
    p_actor_user_id: args.userId,
    p_sent_at: args.sentAt || null,
  })

  if (error || !data) {
    throw new InvoiceDeliverySnapshotError(
      `Failed to persist manual invoice delivery: ${error?.message || 'unknown error'}`,
    )
  }

  return data as InvoiceDelivery
}

/**
 * Record the invoice PDF imported from the previous system (Fortnox) as the
 * invoice's archived copy: a delivery with channel 'import', no recipients and
 * no message. The service-only RPC re-authorizes userId as a writable member,
 * reads the evidence columns from the stored document and keeps one imported
 * original per invoice. Returns the delivery id, or null when the invoice
 * already holds its imported original (another run got there first).
 */
export async function recordImportedInvoiceDelivery(args: {
  companyId: string
  userId: string
  invoiceId: string
  provider: string
  providerMessageId: string
  documentId: string
}): Promise<string | null> {
  const { data, error } = await createServiceClient().rpc('record_imported_invoice_delivery', {
    p_company_id: args.companyId,
    p_invoice_id: args.invoiceId,
    p_actor_user_id: args.userId,
    p_provider: args.provider,
    p_provider_message_id: args.providerMessageId,
    p_document_attachment_id: args.documentId,
  })

  if (error) {
    throw new InvoiceDeliverySnapshotError(
      `Failed to persist imported invoice delivery: ${error.message || 'unknown error'}`,
    )
  }

  return typeof data === 'string' ? data : null
}

/**
 * The company's invoices that already hold an imported original. Read with
 * the service client: the delivery history's SELECT policy shows a member only
 * the deliveries they made, and an import another member ran counts too.
 */
export async function fetchInvoicesWithImportedCopy(companyId: string): Promise<Set<string>> {
  const service = createServiceClient()
  const rows = await fetchAllRows<{ id: string; invoice_id: string }>(({ from, to }) =>
    service
      .from('invoice_deliveries')
      .select('id, invoice_id')
      .eq('company_id', companyId)
      .eq('channel', 'import')
      .order('id', { ascending: true })
      .range(from, to),
  )
  return new Set(rows.map((row) => row.invoice_id))
}
