/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/send
 *
 * Full send pipeline. Renders the invoice PDF, emails it to the customer
 * (with a copy to the company), allocates the F-series number, posts the
 * journal entry when the company books at issue, archives the PDF as underlag, and
 * emits invoice.sent. This is :mark-sent + PDF + email + archival.
 *
 * Failure ordering (matches the dashboard's internal /api/invoices/[id]/send
 * exactly so the two surfaces stay reconcilable):
 *
 *   1. Email service NOT configured → 503 INVOICE_SEND_EMAIL_NOT_CONFIGURED.
 *      Hard fail before any state changes.
 *   2. Customer has no email → 400 INVOICE_SEND_NO_CUSTOMER_EMAIL.
 *   3. Company settings missing → 404 INVOICE_SEND_COMPANY_SETTINGS_MISSING.
 *   4. Cancelled invoices are rejected: sending one would silently
 *      re-activate it (the status flip below has no race guard tightening
 *      `cancelled`). Returns 400 INVOICE_SEND_CANCELLED.
 *   5. Preflight PDF render (with a placeholder F-PREVIEW number) validates
 *      the rendering pipeline BEFORE consuming an F-series number. Fail →
 *      500 INVOICE_SEND_PDF_RENDER_FAILED, no number burned.
 *   6. ensureInvoiceNumber allocates the F-series number atomically.
 *      Fail → 500 INVOICE_SEND_NUMBER_ASSIGN_FAILED.
 *   6b. Auto-create an online payment link (extension-provided, e.g. Stripe)
 *      and persist it on the invoice row. Best-effort: a provider or persist
 *      failure never blocks the send; it surfaces as a PAYMENT_LINK_FAILED
 *      warning on the response once the email is delivered.
 *   7. Final PDF render with the real number.
 *   8. Email send via the email extension (Resend or SMTP). Fail → 502
 *      INVOICE_SEND_PROVIDER_FAILED. The number IS consumed at this point;
 *      same orphan-window as :mark-sent (architecturally tracked).
 *   9. POINT OF NO RETURN. Steps below are best-effort; failures surface
 *      as `warnings` on the response. Status flip → 'sent', journal entry
 *      (book-at-issue + real invoice), PDF archival via uploadDocument,
 *      invoice.sent event emission.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable: dry-run goes
 * through steps 1-5 (validation + preflight PDF) without allocating a
 * number, sending email, or mutating state.
 */

import { z } from 'zod'
import { renderToBuffer } from '@react-pdf/renderer'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { applyPaymentLinkToInvoice } from '@/lib/extensions/payment-links'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailSubject,
  generateInvoiceEmailText,
} from '@/lib/email/invoice-templates'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
  InvoiceDeliverySnapshotError,
} from '@/lib/invoices/invoice-deliveries'
import {
  EMAIL_PATTERN,
  exceedsInvoiceEmailRecipientLimit,
  MAX_INVOICE_EMAIL_COPY_RECIPIENTS,
  findAdditionalInvoiceRecipientCollisions,
  invoiceEmailRecipientCount,
  resolveInvoiceEmailRecipients,
} from '@/lib/invoices/email-recipients'
import {
  hasRequiredInvoicePaymentAccount,
  invoiceRequiresPaymentAccount,
} from '@/lib/invoices/payment-accounts'
import { hasRequiredSellerVatNumber } from '@/lib/invoices/seller-vat-number'
import { eventBus } from '@/lib/events'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { INVOICE_FULL_COLUMNS, INVOICE_ITEM_FULL_COLUMNS } from '@/lib/api/v1/invoice-columns'
import type { CompanySettings, Customer, EntityType, Invoice, InvoiceItem } from '@/types'

const InvoiceSendBody = z.object({
  additional_cc: z.array(z.string().trim().pipe(z.email().max(254)))
    .max(MAX_INVOICE_EMAIL_COPY_RECIPIENTS)
    .optional(),
  additional_bcc: z.array(z.string().trim().pipe(z.email().max(254)))
    .max(MAX_INVOICE_EMAIL_COPY_RECIPIENTS)
    .optional(),
}).refine(
  (data) => (
    (data.additional_cc?.length ?? 0) + (data.additional_bcc?.length ?? 0)
    <= MAX_INVOICE_EMAIL_COPY_RECIPIENTS
  ),
  { path: ['additional_cc'] },
)

const InvoiceSendResponse = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  status: z.literal('sent'),
  total: z.number(),
  message_id: z.string().nullable(),
  sent_to: z.string(),
  cc: z.string().nullable().describe(
    'Deprecated compatibility field containing only the first CC recipient. Use cc_addresses for the complete delivery list.',
  ),
  cc_addresses: z.array(z.string()),
  journal_entry_id: z.string().uuid().nullable(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
})

registerEndpoint({
  operation: 'invoices.send',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/send',
  summary: 'Send a draft invoice to the customer by email.',
  description:
    'The full send pipeline: preflight PDF render → allocate F-series number atomically → final PDF render → email via the email extension (Resend or SMTP; PDF attachment, copy to company) → flip status to sent → post journal entry (real invoice, unless kontantmetoden or defer_invoice_booking) → archive PDF as underlag → emit invoice.sent. Email failure is a hard 502 before state changes; post-email failures surface as warnings but the invoice IS marked sent.',
  useWhen:
    'You want Accounted to deliver the invoice to the customer via email. Peppol e-invoices are sent from the invoice page in the dashboard (per-company access grant requested under Inställningar > Fakturering (Settings > Invoicing); aktiebolag senders, standard invoices only, Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 % only, no ROT/RUT deductions); a v1 or MCP Peppol send action is not yet available. A successful dashboard Peppol send issues the invoice itself, so do not call :mark-sent after it; only if the dashboard reports that the invoice was sent via Peppol but could not be marked as sent does :mark-sent complete the issuance. For invoices delivered through another channel (an external e-invoice provider, postal, own SMTP) use :mark-sent instead.',
  doNotUseFor:
    'Re-sending an already-sent invoice (returns 409 INVOICE_UPDATE_NOT_DRAFT). Sending a delivery note (no F-series lifecycle). Sending a credit note (use the :credit endpoint to issue the kreditfaktura; subsequent re-send of the credit note via :mark-sent is the supported path).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'Email service must be configured: without RESEND_API_KEY + RESEND_FROM_EMAIL (or an SMTP relay via EMAIL_PROVIDER=smtp) the endpoint returns 503 INVOICE_SEND_EMAIL_NOT_CONFIGURED.',
    'Customer must have an email address. 400 INVOICE_SEND_NO_CUSTOMER_EMAIL otherwise.',
    'A cancelled invoice is rejected (400 INVOICE_SEND_CANCELLED): its F-series number is preserved for compliance but the document is not a valid faktura.',
    'Email failure before the status flip leaves the F-series number consumed but the invoice in `draft` status. Same orphan window as :mark-sent (architecturally tracked, matches internal route).',
    'After the email succeeds, journal-entry/archive/event failures become warnings on the response; the invoice IS marked sent regardless.',
    'additional_cc and additional_bcc require the API key user to be an owner or admin of the company.',
    'The deprecated cc response field contains only the first address. Use cc_addresses for the complete CC list.',
    'BCC recipients are retained only in the restricted delivery archive and are omitted from normal and dry-run responses.',
  ],
  example: {
    request: {
      additional_cc: ['case-owner@company.test'],
      additional_bcc: ['invoice-archive@company.test'],
    },
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        status: 'sent',
        total: 12500,
        message_id: 're_abc123',
        sent_to: 'finance@acme.test',
        cc: 'billing@gnubok-user.test',
        cc_addresses: ['billing@gnubok-user.test'],
        journal_entry_id: '7b3a…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: InvoiceSendBody },
  response: { success: dataEnvelope(InvoiceSendResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.send',
  async (request, ctx, params) => {
    const { id } = await params.params

    let rawBody: unknown = {}
    const bodyText = await request.text()
    if (bodyText) {
      try {
        rawBody = JSON.parse(bodyText)
      } catch {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'body', message: 'Body is not valid JSON.' },
        })
      }
    }

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    // Sandbox demo never sends a real email: guard the whole pipeline
    // before any number is allocated or PDF is rendered.
    const blocked = await guardSandbox(ctx.supabase, ctx.companyId!)
    if (blocked) return blocked

    const capBlocked = await requireCapability(ctx.supabase, ctx.companyId!, CAPABILITY.email_send)
    if (capBlocked) return capBlocked

    // Step 1: email service configured?
    const emailService = getEmailService()
    if (!emailService.isConfigured()) {
      return v1ErrorResponseFromCode('INVOICE_SEND_EMAIL_NOT_CONFIGURED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Fetch invoice + customer + items. Uses the shared full projections so
    // the row feeding the PDF/email/journal entry cannot drift from what GET
    // returns: an earlier hand-rolled list here silently dropped
    // deduction_total, which made v1-sent ROT/RUT invoices overstate
    // "Att betala" (default_dimensions must also stay: createInvoiceJournalEntry
    // reads the bag off this row).
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(
        // deduction_personnummer_encrypted rides along for the render only:
        // the PDF template derives the masked personnummer (YYYYMMDD-XXXX)
        // from it. It stays out of INVOICE_FULL_COLUMNS (the API projection)
        // and this route never echoes the row.
        `${INVOICE_FULL_COLUMNS}, deduction_personnummer_encrypted, customer:customers(id, name, customer_number, email, customer_type, country, address_line1, address_line2, postal_code, city, vat_number, invoice_email_cc_addresses, invoice_email_bcc_addresses), items:invoice_items(${INVOICE_ITEM_FULL_COLUMNS})`,
      )
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      ctx.log.warn('invoices.send: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    const typed = invoice as unknown as Invoice & {
      customer?: Customer
      items?: InvoiceItem[]
    }

    // Step 4: cancelled invoices.
    if (typed.status === 'cancelled') {
      return v1ErrorResponseFromCode('INVOICE_SEND_CANCELLED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Reject already-sent: same contract as :mark-sent. Re-send is not a
    // supported v1 operation; use the dashboard or a fresh credit-and-reissue.
    if (typed.status !== 'draft') {
      return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    const bodyResult = InvoiceSendBody.safeParse(rawBody)
    if (!bodyResult.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: bodyResult.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        },
      })
    }

    // Reject delivery notes: they have a different (D-series) lifecycle.
    if (typed.document_type === 'delivery_note') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'document_type',
          message: 'Delivery notes are not sent via this endpoint; use the dashboard or a custom channel.',
        },
      })
    }

    // Reject credit notes. `:credit` creates them atomically in 'sent' state
    // with their own number: there is no v1 path that produces a draft
    // credit note, so reaching :send with credited_invoice_id set is either
    // a misuse or a manual DB edit. Allowing it would give a credit note
    // an F-series number; ML 17 kap 22-23§ require (a) a distinct
    // kreditfaktura series and (b) an explicit back-reference to the
    // original invoice's löpnummer: neither enforced by this route.
    // Any future "send a credit note" v1 path MUST honor both.
    if (typed.credited_invoice_id) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'credited_invoice_id',
          message:
            'Credit notes cannot be sent via this endpoint. Use POST /invoices/{id}/credit, which creates and sends the credit note atomically.',
        },
      })
    }

    if (!typed.moms_ruta) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'moms_ruta',
          message: 'Invoice has no moms_ruta set; re-create the draft via POST /invoices.',
        },
      })
    }

    // Step 2: customer email.
    const customer = typed.customer
    if (!customer?.email?.trim() || !EMAIL_PATTERN.test(customer.email.trim())) {
      return v1ErrorResponseFromCode('INVOICE_SEND_NO_CUSTOMER_EMAIL', ctx.log, {
        requestId: ctx.requestId,
        details: { customer_id: typed.customer_id },
      })
    }

    // Step 3: company settings. The whole CompanySettings shape is passed to
    // the InvoicePDF template: header info, bank details, contact, address,
    // entity type. `select('*')` is intentional: CompanySettings is a flat
    // owner-facing config object with no sensitive columns today (no API
    // tokens, no billing data: those live in scoped tables). If a future
    // migration adds a sensitive column, the right fix is to put it in a
    // separate table, not retrofit a column allow-list here.
    const { data: company, error: companyErr } = await ctx.supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (companyErr || !company) {
      return v1ErrorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', ctx.log, {
        requestId: ctx.requestId,
      })
    }
    const settings = company as CompanySettings & { accounting_method?: string }
    const paymentAccountRequired = invoiceRequiresPaymentAccount(typed)
    if (!hasRequiredInvoicePaymentAccount(settings, typed)) {
      return v1ErrorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', ctx.log, {
        requestId: ctx.requestId,
        details: { currency: typed.currency },
      })
    }

    if (!hasRequiredSellerVatNumber(settings, typed)) {
      return v1ErrorResponseFromCode('INVOICE_SEND_VAT_NUMBER_MISSING', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const hasAdditionalRecipients =
      (bodyResult.data.additional_cc?.length ?? 0) > 0
      || (bodyResult.data.additional_bcc?.length ?? 0) > 0
    // Fixed recipients are owner/admin-approved company routing. A fresh role
    // check is required only when this request introduces another recipient.
    if (hasAdditionalRecipients) {
      const { data: membership, error: membershipError } = await ctx.supabase
        .from('company_members')
        .select('role')
        .eq('company_id', ctx.companyId!)
        .eq('user_id', ctx.userId)
        .maybeSingle()

      if (membershipError) {
        ctx.log.error('invoices.send: failed to authorize custom recipients', membershipError)
        return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
          requestId: ctx.requestId,
        })
      }
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return v1ErrorResponseFromCode('FORBIDDEN', ctx.log, {
          requestId: ctx.requestId,
          details: { required_roles: ['owner', 'admin'] },
        })
      }
    }

    const recipientInput = {
      to: customer.email,
      configuredCc: settings.invoice_email_cc_addresses,
      configuredBcc: settings.invoice_email_bcc_addresses,
      customerCc: customer.invoice_email_cc_addresses,
      customerBcc: customer.invoice_email_bcc_addresses,
      // The company email is fixed routing, not an arbitrary
      // request-controlled recipient.
      legacyCc: settings.email,
      additionalCc: bodyResult.data.additional_cc,
      additionalBcc: bodyResult.data.additional_bcc,
    }
    const recipientCollisions = findAdditionalInvoiceRecipientCollisions(recipientInput)
    if (recipientCollisions.length > 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'recipients', collisions: recipientCollisions },
      })
    }
    const recipients = resolveInvoiceEmailRecipients(recipientInput)
    if (recipients.to.length === 0) {
      return v1ErrorResponseFromCode('INVOICE_SEND_NO_CUSTOMER_EMAIL', ctx.log, {
        requestId: ctx.requestId,
        details: { customer_id: typed.customer_id },
      })
    }
    if (exceedsInvoiceEmailRecipientLimit(recipients)) {
      return v1ErrorResponseFromCode('INVOICE_SEND_TOO_MANY_RECIPIENTS', ctx.log, {
        requestId: ctx.requestId,
        details: { recipient_count: invoiceEmailRecipientCount(recipients) },
      })
    }
    const items = (typed.items ?? []).slice().sort((a, b) => a.sort_order - b.sort_order)
    // Credit notes are rejected above, so originalInvoiceNumber is never
    // needed on this code path. Kept undefined to satisfy the InvoicePDF
    // signature (it tolerates undefined for non-credit-notes).
    const originalInvoiceNumber: string | undefined = undefined

    // Step 5: preflight PDF render. Validate the pipeline with a placeholder
    // number BEFORE consuming an F-series number.
    const isFreshAllocation = !typed.invoice_number
    if (isFreshAllocation) {
      try {
        const preflight = await prepareInvoicePdfRender(settings, typed.currency, {
          paymentAccountRequired,
        })
        await renderToBuffer(
          InvoicePDF({
            invoice: { ...(typed as Invoice), invoice_number: 'F-PREVIEW' },
            customer,
            items,
            company: preflight.company,
            originalInvoiceNumber,
            branding: preflight.branding,
          }),
        )
      } catch (err) {
        ctx.log.error('invoices.send: preflight PDF render failed', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        return v1ErrorResponseFromCode('INVOICE_SEND_PDF_RENDER_FAILED', ctx.log, {
          requestId: ctx.requestId,
        })
      }
    }

    if (ctx.dryRun) {
      // Dry-run stops here. Validated everything that doesn't have side
      // effects; preview the would-be sent state.
      const response = dryRunPreview(
        {
          ...typed,
          status: 'sent' as const,
          invoice_number: typed.invoice_number ?? '(allocated atomically on commit)',
          would_send_to: customer.email,
          would_cc: recipients.cc[0] ?? null,
          would_cc_addresses: recipients.cc,
          would_create_journal_entry:
            (!typed.document_type || typed.document_type === 'invoice') &&
            booksInvoicesOnIssue(settings),
          accounting_method: settings.accounting_method ?? 'accrual',
          preflight_pdf_render: 'ok',
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
      response.headers.set('Cache-Control', 'private, no-store')
      return response
    }

    let deliveryId: string
    try {
      deliveryId = await reserveInvoiceDelivery({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        invoiceId,
      })
    } catch (err) {
      ctx.log.error('invoices.send: delivery reservation failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_SNAPSHOT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { retryable: err instanceof InvoiceDeliverySnapshotError },
      })
    }

    // Step 6: allocate F-series number atomically.
    try {
      await ensureInvoiceNumber(ctx.supabase, ctx.companyId!, typed as Invoice)
    } catch (err) {
      ctx.log.error('invoices.send: ensureInvoiceNumber failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_NUMBER_ASSIGN_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Step 7: final PDF render with the assigned number. typed.invoice_number
    // was mutated by ensureInvoiceNumber. Re-read to be safe. A re-read
    // failure (transient connection error) is non-fatal: `typed.invoice_number`
    // was just written by the RPC in step 6, so it's the authoritative
    // in-memory value. Log a warning and fall back.
    const { data: numbered, error: reReadErr } = await ctx.supabase
      .from('invoices')
      .select('invoice_number')
      .eq('id', invoiceId)
      .eq('company_id', ctx.companyId!)
      .single()
    if (reReadErr) {
      ctx.log.warn(
        'invoices.send: re-read after number allocation failed, falling back to in-memory value',
        {
          invoiceId,
          companyId: ctx.companyId,
          err: reReadErr,
        },
      )
    }
    const finalInvoiceNumber =
      (numbered as { invoice_number?: string } | null)?.invoice_number ?? typed.invoice_number

    // Step 6b: auto-create an online payment link (extension-provided, e.g.
    // Stripe) now that the number exists, so the email button and PDF QR
    // carry it. Failure degrades to a PAYMENT_LINK_FAILED warning: the
    // faktura is legally valid without a link. The helper mirrors the link
    // onto the in-memory row only after a successful persist so a link on
    // the PDF can always be matched back to the row.
    const { failure: paymentLinkFailure } = await applyPaymentLinkToInvoice(
      ctx.supabase,
      ctx.companyId!,
      ctx.userId,
      typed as Invoice,
      ctx.log,
      {
        invoiceNumber: finalInvoiceNumber,
        logPrefix: 'invoices.send: ',
        logContext: { invoiceId },
      },
    )

    // Also override `status` to 'sent' on the in-memory copy. The actual DB
    // flip happens at step 9a (after email delivery), but if we render with
    // the stale 'draft' status the customer receives a PDF stamped
    // "UTKAST: inte en giltig faktura".
    const renderableInvoice: Invoice = {
      ...(typed as Invoice),
      invoice_number: finalInvoiceNumber,
      status: 'sent',
    }

    let pdfBuffer: Buffer
    try {
      const { branding, company: renderCompany } = await prepareInvoicePdfRender(
        settings,
        renderableInvoice.currency,
        { paymentAccountRequired },
      )
      const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, renderableInvoice)
      const paymentLinkQrDataUrl = await buildPaymentLinkQrDataUrl(renderableInvoice)
      pdfBuffer = await renderToBuffer(
        InvoicePDF({
          invoice: renderableInvoice,
          customer,
          items,
          company: renderCompany,
          originalInvoiceNumber,
          branding,
          swishQrDataUrl,
          paymentLinkQrDataUrl,
        }),
      )
    } catch (err) {
      // F-series number IS consumed at this point (orphan window).
      ctx.log.error('invoices.send: final PDF render failed AFTER number allocation', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
        invoiceNumber: finalInvoiceNumber,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_PDF_RENDER_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Step 8: send the email. Delivery notes AND credit notes were rejected
    // earlier so docType is 'invoice' or 'proforma' here.
    const filename = invoicePdfFilename({
      companyName: settings.company_name,
      customerName: customer.name,
      invoiceNumber: finalInvoiceNumber,
      invoiceId: typed.id,
      invoiceDate: typed.invoice_date,
      documentType: typed.document_type,
    })

    const emailData = { invoice: renderableInvoice, customer, company: settings }
    const subject = generateInvoiceEmailSubject(emailData)
    const html = generateInvoiceEmailHtml(emailData)
    const text = generateInvoiceEmailText(emailData)
    let result
    try {
      result = await sendTrackedInvoiceEmail({
        supabase: ctx.supabase,
        emailService,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        invoiceId,
        deliveryId,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject,
        html,
        text,
        replyTo: settings.email ?? undefined,
        fromName: settings.company_name ?? undefined,
        from: await resolveInvoiceSender(ctx.supabase, ctx.companyId!, settings.company_name),
        filename,
        pdfBuffer,
      })
    } catch (err) {
      ctx.log.error('invoices.send: delivery snapshot failed before email', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_SNAPSHOT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { retryable: err instanceof InvoiceDeliverySnapshotError },
      })
    }

    if (!result.success) {
      if (result.trackingWarning) {
        ctx.log.warn('invoices.send: failed delivery snapshot not reconciled', {
          invoiceId,
          companyId: ctx.companyId,
          deliveryId: result.deliveryId,
          warning: result.trackingWarning,
        })
      }
      ctx.log.error('invoices.send: email provider failed', new Error(result.error ?? 'unknown'), {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_SEND_PROVIDER_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // ── POINT OF NO RETURN ────────────────────────────────────────────
    // Email has been delivered. Subsequent failures surface as warnings.
    const warnings: { code: string; message: string }[] = []

    if (result.trackingWarning) {
      ctx.log.warn('invoices.send: delivery snapshot not finalized', {
        invoiceId,
        companyId: ctx.companyId,
        deliveryId: result.deliveryId,
      })
      warnings.push({
        code: 'DELIVERY_HISTORY_FINALIZE_FAILED',
        message: 'The delivery snapshot exists but could not be finalized. Reconcile the pending delivery record.',
      })
    }

    if (paymentLinkFailure) {
      warnings.push({ code: 'PAYMENT_LINK_FAILED', message: paymentLinkFailure })
    }

    // Step 9a: status flip to 'sent'. The `.eq('status', 'draft')` is an
    // optimistic-lock guard against a concurrent state change between fetch
    // and write. PostgREST returns `{ error: null }` for 0-row updates, so
    // we MUST `.select('id')` and check the row count: a silent zero-row
    // miss would leave the DB in 'draft' while the response claims 'sent'
    // and the email is already gone.
    let statusFlipped = true
    const { data: flipRows, error: statusErr } = await ctx.supabase
      .from('invoices')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .eq('company_id', ctx.companyId!)
      .eq('status', 'draft')
      .select('id')
    if (statusErr || !flipRows || flipRows.length === 0) {
      statusFlipped = false
      ctx.log.error(
        'invoices.send: status flip failed AFTER email delivery',
        (statusErr ?? new Error('0 rows matched (concurrent state change)')) as Error,
        {
          invoiceId,
          companyId: ctx.companyId,
          rowsMatched: flipRows?.length ?? 0,
        },
      )
      warnings.push({
        code: 'STATUS_UPDATE_FAILED',
        message:
          'Email delivered but the invoice could not be marked as sent. Reconcile manually: the DB row may still be in draft.',
      })
    }

    // Step 9b: journal entry for real invoices when the company books at
    // issue. Kontantmetoden books at payment; defer_invoice_booking (#967)
    // books via the explicit Bokför step. Same gate as the dashboard.
    let journalEntryId: string | null = null
    const isRealInvoice = !typed.document_type || typed.document_type === 'invoice'
    if (isRealInvoice && booksInvoicesOnIssue(settings)) {
      try {
        const entry = await createInvoiceJournalEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          renderableInvoice,
          (settings.entity_type ?? 'enskild_firma') as EntityType,
          customer.name,
        )
        if (entry) {
          journalEntryId = entry.id
          const { error: writeBackErr } = await ctx.supabase
            .from('invoices')
            .update({ journal_entry_id: entry.id })
            .eq('id', invoiceId)
            .eq('company_id', ctx.companyId!)
          if (writeBackErr) {
            ctx.log.error('invoices.send: journal_entry_id write-back failed', writeBackErr as Error, {
              invoiceId,
              journalEntryId: entry.id,
            })
            warnings.push({
              code: 'JOURNAL_ENTRY_ID_WRITEBACK_FAILED',
              message: 'Journal entry was posted but the invoice row could not be updated with its id.',
            })
          }
        } else {
          warnings.push({
            code: 'JOURNAL_ENTRY_NOT_POSTED',
            message: 'Invoice was sent but the journal entry was not posted (likely no open fiscal period). Reconcile before period close.',
          })
        }
      } catch (err) {
        ctx.log.error('invoices.send: journal entry creation failed', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        warnings.push({
          code: 'JOURNAL_ENTRY_NOT_POSTED',
          message: 'Invoice was sent but the journal entry posting failed. Check engine logs; reconcile for BFL 5 kap compliance.',
        })
      }
    }

    // Step 9c: link the already archived exact delivery PDF to the entry.
    if (isRealInvoice && journalEntryId) {
      try {
        await linkToJournalEntry(
          ctx.supabase,
          ctx.companyId!,
          result.documentId,
          journalEntryId,
        )
      } catch (err) {
        ctx.log.error('invoices.send: archived PDF journal link failed', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        warnings.push({
          code: 'PDF_JOURNAL_LINK_FAILED',
          message: 'The exact sent PDF was archived but could not be linked to the journal entry.',
        })
      }
    }

    // Step 9d: emit invoice.sent.
    try {
      await eventBus.emit({
        type: 'invoice.sent',
        payload: {
          invoice: renderableInvoice,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.error('invoice.sent emit failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      warnings.push({
        code: 'EVENT_EMIT_FAILED',
        message: 'invoice.sent event did not reach the bus; downstream subscribers may miss this transition.',
      })
    }

    ctx.log.info('invoices.send success', {
      invoiceId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      invoiceNumber: finalInvoiceNumber,
      recipientCounts: {
        to: recipients.to.length,
        cc: recipients.cc.length,
      },
      journalEntryId,
      hadWarnings: warnings.length > 0,
    })

    return ok(
      {
        id: invoiceId,
        invoice_number: finalInvoiceNumber ?? typed.invoice_number ?? null,
        status: statusFlipped ? ('sent' as const) : ('draft' as const),
        total: typed.total,
        message_id: result.messageId ?? null,
        sent_to: customer.email,
        cc: recipients.cc[0] ?? null,
        cc_addresses: recipients.cc,
        journal_entry_id: journalEntryId,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      {
        requestId: ctx.requestId,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    )
  },
  { requireIdempotencyKey: true },
)
