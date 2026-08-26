import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import {
  issueCreditNote,
  type CreditNoteOriginalInvoice,
} from '@/lib/invoices/issue-credit-note'
import { applyPaymentLinkToInvoice } from '@/lib/extensions/payment-links'
import {
  reserveInvoiceDelivery,
  sendTrackedInvoiceEmail,
  InvoiceDeliverySnapshotError,
} from '@/lib/invoices/invoice-deliveries'
import { withRouteContext } from '@/lib/api/with-route-context'
import { SendInvoiceSchema } from '@/lib/api/schemas'
import { parseCustomIssuanceLines } from '@/lib/invoices/issuance-custom-lines'
import {
  EMAIL_PATTERN,
  exceedsInvoiceEmailRecipientLimit,
  findAdditionalInvoiceRecipientCollisions,
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
import type {
  AccountingMethod,
  CompanySettings,
  CreditNote,
  Customer,
  EntityType,
  Invoice,
  InvoiceItem,
} from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'invoice.send',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    // Optional body: user-edited issuance lines. Read here; validated after
    // the ownership fetch below (no payload feedback for foreign invoices)
    // but still long BEFORE the email leaves: after delivery the pipeline
    // only degrades to PARTIAL. Same contract as mark-sent.
    let rawBody: unknown
    const bodyText = await request.text()
    if (bodyText) {
      try {
        rawBody = JSON.parse(bodyText)
      } catch {
        // Malformed JSON must not silently fall back to generated lines.
        return NextResponse.json({ error: 'Ogiltig förfrågan' }, { status: 400 })
      }
    }

    // The sandbox must never deliver a real email to a real customer: block
    // the entire send pipeline (PDF render + Resend send + status flip).
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

    const isCreditNote = !!invoice.credited_invoice_id
    const isCreditDeliveryRetry = isCreditNote && invoice.status === 'sent'

    // A cancelled invoice keeps its F-series number for compliance with ML 17
    // kap 24§ but is not a valid faktura: sending it would deliver a
    // "MAKULERAD" PDF as if it were live. Checked before the generic draft
    // guard below for the more specific error message.
    if (invoice.status === 'cancelled') {
      return errorResponseFromCode('INVOICE_SEND_CANCELLED', opLog, { requestId })
    }

    // Only drafts may enter the send pipeline. The UI already hides Send for
    // non-drafts, but a direct POST against an issued invoice would re-email
    // the customer and post a SECOND revenue verifikat
    // (createInvoiceJournalEntry has no dedup), overwriting journal_entry_id
    // and orphaning the first entry. Mirrors the v1 route and the MCP commit
    // executor, which both reject non-drafts.
    if (invoice.status !== 'draft' && !isCreditDeliveryRetry) {
      return errorResponseFromCode('INVOICE_ALREADY_SENT', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const bodyResult = SendInvoiceSchema.safeParse(rawBody ?? {})
    if (!bodyResult.success) {
      opLog.warn('send validation failed')
      return NextResponse.json(
        { error: 'Ogiltig förfrågan', details: bodyResult.error.flatten() },
        { status: 400 },
      )
    }

    const linesResult = parseCustomIssuanceLines(
      bodyResult.data.lines ? { lines: bodyResult.data.lines } : undefined,
    )
    if (!linesResult.ok) {
      if (linesResult.error === 'invalid_body') {
        opLog.warn('send validation failed')
        return NextResponse.json(
          { error: 'Ogiltig förfrågan', details: linesResult.details },
          { status: 400 },
        )
      }
      return errorResponseFromCode(
        linesResult.error === 'unbalanced'
          ? 'INVOICE_MARK_SENT_LINES_UNBALANCED'
          : 'INVOICE_MARK_SENT_LINES_INVALID',
        opLog,
        { requestId, details: linesResult.details },
      )
    }
    const customLines = linesResult.lines

    // Custom lines only apply where send books inline; elsewhere they are
    // deliberately ignored (documented in MarkInvoiceSentSchema). Logged for
    // audit visibility instead of vanishing silently.
    if (customLines && isCreditNote) {
      opLog.warn('send: custom lines ignored (credit notes book via issueCreditNote)', {
        lineCount: customLines.length,
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

    const invoiceCurrency = (invoice as Invoice).currency
    const paymentAccountRequired = invoiceRequiresPaymentAccount(invoice as Invoice)
    if (!hasRequiredInvoicePaymentAccount(company as CompanySettings, invoice as Invoice)) {
      return errorResponseFromCode('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING', opLog, {
        requestId,
        details: { currency: invoiceCurrency },
      })
    }

    const hasAdditionalRecipients =
      (bodyResult.data.additional_cc?.length ?? 0) > 0
      || (bodyResult.data.additional_bcc?.length ?? 0) > 0
    // Fixed recipients are owner/admin-approved company routing and apply to
    // every writable sender. Only a new per-send disclosure needs this fresh
    // role check. See .compliance/authorization-policy.md.
    if (hasAdditionalRecipients) {
      const { data: membership, error: membershipError } = await supabase
        .from('company_members')
        .select('role')
        .eq('company_id', companyId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (membershipError) {
        opLog.error('failed to authorize custom invoice recipients', membershipError)
        return errorResponseFromCode('INTERNAL_ERROR', opLog, { requestId })
      }
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return errorResponseFromCode('FORBIDDEN', opLog, {
          requestId,
          details: { required_roles: ['owner', 'admin'] },
        })
      }
    }

    const recipientInput = {
      to: customer.email,
      configuredCc: company.invoice_email_cc_addresses,
      configuredBcc: company.invoice_email_bcc_addresses,
      customerCc: customer.invoice_email_cc_addresses,
      customerBcc: customer.invoice_email_bcc_addresses,
      // This value comes from company settings or the authenticated sender. It
      // is fixed routing, not an arbitrary request-controlled recipient.
      legacyCc: company.email || user.email,
      additionalCc: bodyResult.data.additional_cc,
      additionalBcc: bodyResult.data.additional_bcc,
    }
    const recipientCollisions = findAdditionalInvoiceRecipientCollisions(recipientInput)
    if (recipientCollisions.length > 0) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { field: 'recipients', collisions: recipientCollisions },
      })
    }
    const recipients = resolveInvoiceEmailRecipients(recipientInput)
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

    let originalInvoice: CreditNoteOriginalInvoice | undefined
    let originalInvoiceNumber: string | undefined
    if (invoice.credited_invoice_id) {
      const { data: original } = await supabase
        .from('invoices')
        .select('id, invoice_number, external_invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
        .eq('id', invoice.credited_invoice_id)
        .eq('company_id', companyId)
        .single()

      if (!original) {
        return errorResponseFromCode('INVOICE_CREDIT_ORIGINAL_NOT_FOUND', opLog, { requestId })
      }

      originalInvoice = original as CreditNoteOriginalInvoice
      // Self-billed originals carry their number in external_invoice_number
      // (invoice_number is null by design); without the fallback the
      // credit-note PDF loses its ML 17 kap 22 reference to the original
      // (issue #1820).
      originalInvoiceNumber =
        original.invoice_number ?? original.external_invoice_number ?? undefined
    }

    // Preflight render: validate the PDF pipeline BEFORE consuming an F-series
    // number. If the row is already numbered (retry path), skip: we'd just
    // render twice for no gain.
    const isFreshAllocation = !invoice.invoice_number
    if (isFreshAllocation) {
      try {
        const preflight = await prepareInvoicePdfRender(
          company as CompanySettings,
          (invoice as Invoice).currency,
          { paymentAccountRequired },
        )
        await renderToBuffer(
          InvoicePDF({
            invoice: { ...(invoice as Invoice), invoice_number: 'F-PREVIEW' },
            customer,
            items,
            company: preflight.company,
            originalInvoiceNumber,
            branding: preflight.branding,
          }),
        )
      } catch (err) {
        opLog.error('preflight PDF render failed before invoice number assignment', err as Error)
        return errorResponseFromCode('INVOICE_SEND_PDF_RENDER_FAILED', opLog, { requestId })
      }
    }

    let deliveryId: string
    try {
      deliveryId = await reserveInvoiceDelivery({
        supabase,
        companyId: companyId!,
        userId: user.id,
        invoiceId: id,
      })
    } catch (err) {
      opLog.error('failed to reserve invoice delivery before number assignment', err as Error)
      return errorResponseFromCode('INVOICE_SEND_SNAPSHOT_FAILED', opLog, {
        requestId,
        details: { retryable: err instanceof InvoiceDeliverySnapshotError },
      })
    }

    // Allocate the F-series number. Idempotent: retries reuse the same number.
    try {
      await ensureInvoiceNumber(supabase, companyId!, invoice as Invoice)
    } catch (err) {
      opLog.error('failed to assign invoice number on send', err as Error)
      return errorResponseFromCode('INVOICE_SEND_NUMBER_ASSIGN_FAILED', opLog, { requestId })
    }

    // Auto-create an online payment link (extension-provided, e.g. Stripe) now
    // that the number exists, so the email button and PDF QR carry it. A
    // failure never blocks the send: the faktura is legally valid without a
    // link, so it degrades to a PARTIAL warning instead.
    const { failure: paymentLinkFailure } = isCreditNote
      ? { failure: undefined }
      : await applyPaymentLinkToInvoice(
          supabase,
          companyId!,
          user.id,
          invoice as Invoice,
          opLog,
        )

    // Final render with the assigned number: this is the buffer attached to
    // the email and later archived as underlag. Override status to 'sent' on
    // the in-memory copy: the DB flip happens after email delivery (line
    // ~185), but if we render with the stale 'draft' status the customer
    // receives a PDF stamped "UTKAST: inte en giltig faktura".
    const renderableInvoice = { ...(invoice as Invoice), status: 'sent' as const }
    const { branding, company: renderCompany } = await prepareInvoicePdfRender(
      company as CompanySettings,
      renderableInvoice.currency,
      { paymentAccountRequired },
    )
    const swishQrDataUrl = await buildSwishQrDataUrl(renderCompany, renderableInvoice)
    const paymentLinkQrDataUrl = await buildPaymentLinkQrDataUrl(renderableInvoice)
    const pdfBuffer = await renderToBuffer(
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

    const emailData = {
      invoice: renderableInvoice,
      customer,
      company: company as CompanySettings,
    }

    const filename = invoicePdfFilename({
      companyName: company.company_name,
      customerName: customer.name,
      invoiceNumber: invoice.invoice_number,
      invoiceId: invoice.id,
      invoiceDate: invoice.invoice_date,
      documentType: invoice.document_type,
      isCreditNote,
    })

    const partialFailures: Array<{ step: string; reason: string }> = []
    if (paymentLinkFailure) {
      // The failure string is a raw provider/DB message: log it, but the
      // response field is user-visible and must stay Swedish (issue #337).
      opLog.warn('payment link creation failed on send', { reason: paymentLinkFailure })
      partialFailures.push({
        step: 'payment_link',
        reason: 'Betalningslänken kunde inte skapas. Fakturan skickades utan betalningslänk.',
      })
    }

    let statusFlipped = isCreditDeliveryRetry
    let creditJournalEntryId: string | null = null

    // Credit notes must be fully issued and booked before delivery. The CAS is
    // the single-winner lock; the idempotent issue service can repair any
    // immutable entry that committed before a later database step failed.
    if (isCreditNote && originalInvoice) {
      if (!isCreditDeliveryRetry) {
        const { data: flipRows, error: updateError } = await supabase
          .from('invoices')
          .update({ status: 'sent' })
          .eq('id', id)
          .eq('company_id', companyId)
          .eq('status', 'draft')
          .select('id')

        if (updateError) {
          opLog.error('credit note status update failed before issue', updateError)
          return errorResponseFromCode('INVOICE_CREDIT_ISSUE_INCOMPLETE', opLog, {
            requestId,
            details: { failure_steps: ['status_update'] },
          })
        }
        if (!flipRows || flipRows.length === 0) {
          return errorResponseFromCode('INVOICE_ALREADY_SENT', opLog, {
            requestId,
            details: { currentStatus: 'sent' },
          })
        }
        statusFlipped = true
      }

      const issueResult = await issueCreditNote({
        supabase,
        companyId: companyId!,
        userId: user.id,
        creditNote: invoice as CreditNote,
        originalInvoice,
        entityType: ((company as CompanySettings).entity_type as EntityType) || 'enskild_firma',
        accountingMethod: ((company as Record<string, unknown>).accounting_method || 'accrual') as AccountingMethod,
        log: opLog,
      })
      creditJournalEntryId = issueResult.journalEntryId

      if (!issueResult.complete) {
        if (issueResult.journalEntryRequired && !issueResult.journalEntryId) {
          await supabase
            .from('invoices')
            .update({ status: 'draft' })
            .eq('id', id)
            .eq('company_id', companyId)
            .eq('status', 'sent')
            .is('journal_entry_id', null)
        }
        return errorResponseFromCode(
          issueResult.repairRequired
            ? 'INVOICE_CREDIT_REPAIR_REQUIRED'
            : 'INVOICE_CREDIT_ISSUE_INCOMPLETE',
          opLog,
          {
            requestId,
            details: { failure_steps: issueResult.failures.map((failure) => failure.step) },
          },
        )
      }
    }

    const subject = generateInvoiceEmailSubject(emailData)
    const html = generateInvoiceEmailHtml(emailData)
    const text = generateInvoiceEmailText(emailData)

    let result
    try {
      result = await sendTrackedInvoiceEmail({
        supabase,
        emailService,
        companyId: companyId!,
        userId: user.id,
        invoiceId: id,
        deliveryId,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject,
        html,
        text,
        replyTo: company.email || undefined,
        fromName: company.company_name,
        from: await resolveInvoiceSender(supabase, companyId!, company.company_name),
        filename,
        pdfBuffer,
      })
    } catch (err) {
      opLog.error('failed to persist invoice delivery snapshot before send', err as Error)
      return errorResponseFromCode('INVOICE_SEND_SNAPSHOT_FAILED', opLog, {
        requestId,
        details: { retryable: err instanceof InvoiceDeliverySnapshotError },
      })
    }

    if (!result.success) {
      if (result.trackingWarning) {
        opLog.warn('invoice send: failed delivery snapshot not reconciled', {
          invoiceId: id,
          deliveryId: result.deliveryId,
          warning: result.trackingWarning,
        })
      }
      opLog.error('email provider failed to send invoice', new Error(result.error || 'Unknown'))
      return errorResponseFromCode('INVOICE_SEND_PROVIDER_FAILED', opLog, {
        requestId,
        details: { retryable: true },
      })
    }

    if (result.trackingWarning) {
      opLog.warn('invoice send: delivery snapshot not finalised', {
        invoiceId: id,
        deliveryId: result.deliveryId,
      })
      partialFailures.push({
        step: 'delivery_history',
        reason: 'Utskicket sparades men kunde inte färdigmarkeras i historiken.',
      })
    }

    // From here on the invoice has reached the customer. Failures in the
    // follow-up steps degrade the response to PARTIAL: the user gets a
    // success toast with a sub-warning, and the audit trail records exactly
    // which sub-step broke.
    // Optimistic-locked flip (draft → sent). Two concurrent sends can both
    // pass the draft guard above and both email the customer, but only the
    // request that wins this compare-and-set runs the bookkeeping steps
    // below: the loser would otherwise post a duplicate revenue verifikat
    // and archive the PDF twice. PostgREST returns no error for a 0-row
    // update, so the row count via .select('id') is the actual lock signal.
    // A genuine update error also skips the follow-ups: the row is still
    // 'draft', so a later retry re-runs the whole pipeline and ends with
    // exactly one journal entry (at the cost of a duplicate email).
    if (!isCreditNote) {
      const { data: flipRows, error: updateError } = await supabase
        .from('invoices')
        .update({ status: 'sent' })
        .eq('id', id)
        .eq('company_id', companyId)
        .eq('status', 'draft')
        .select('id')

      if (updateError) {
        opLog.warn('failed to update invoice status to sent', updateError)
        partialFailures.push({
          step: 'status_update',
          reason: 'Fakturans status kunde inte uppdateras till skickad.',
        })
      } else if (!flipRows || flipRows.length === 0) {
        opLog.warn('invoice already flipped to sent by a concurrent request; skipping bookkeeping follow-ups')
        partialFailures.push({
          step: 'status_update',
          reason: 'Fakturan skickades samtidigt av en annan begäran; bokföringen hanterades där.',
        })
      } else {
        statusFlipped = true
      }
    }

    const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
    let createdJournalEntryId: string | undefined = creditJournalEntryId ?? undefined

    // #967: deferred companies send WITHOUT booking; ekonomi books later via
    // POST /api/invoices/[id]/book. The invoice then legitimately sits at
    // journal_entry_id = NULL until then, like under kontantmetoden.
    if (
      customLines &&
      !isCreditNote &&
      (!isRealInvoice || !booksInvoicesOnIssue(company as CompanySettings))
    ) {
      opLog.warn('send: custom lines ignored (not on accrual book-at-issue path)', {
        lineCount: customLines.length,
      })
    }

    if (statusFlipped && !isCreditNote && isRealInvoice && booksInvoicesOnIssue(company as CompanySettings)) {
      try {
        if (customLines) {
          // Audit trail: distinguish user-edited bookings from generated ones.
          opLog.info('send: booking user-edited custom lines', {
            userId: user.id,
            lineCount: customLines.length,
          })
        }
        const journalEntry = customLines
          ? await createInvoiceJournalEntry(
              supabase,
              companyId!,
              user.id,
              invoice as Invoice,
              (company as CompanySettings).entity_type,
              undefined,
              { customLines },
            )
          : await createInvoiceJournalEntry(
              supabase,
              companyId!,
              user.id,
              invoice as Invoice,
              (company as CompanySettings).entity_type,
            )
        if (journalEntry) {
          createdJournalEntryId = journalEntry.id
          await supabase
            .from('invoices')
            .update({ journal_entry_id: journalEntry.id })
            .eq('id', id)

          // Periodiserade lines: create their schedules + catch-up
          // dissolutions now that the revenue entry exists. Failures degrade
          // to PARTIAL: the entry is committed and must not be rolled back.
          // Skipped for user-edited lines: the generated 29xx deferral may
          // not exist in what was booked; edited lines book as reviewed.
          if (!customLines) {
            const accrual = await createSchedulesForCustomerInvoice(
              supabase,
              companyId!,
              user.id,
              invoice as Invoice,
              items,
              journalEntry.id,
              (company as CompanySettings).entity_type,
            )
            if (accrual.failed > 0) {
              partialFailures.push({
                step: 'accrual_schedules',
                reason: `${accrual.failed} periodisering(ar) kunde inte skapas`,
              })
            }
          }
        }
      } catch (err) {
        opLog.error('failed to create invoice journal entry on send', err as Error)
        partialFailures.push({
          step: 'journal_entry',
          reason: 'Fakturans verifikat kunde inte skapas.',
        })
      }
    }

    if (statusFlipped && isRealInvoice && createdJournalEntryId) {
      try {
        await linkToJournalEntry(
          supabase,
          companyId!,
          result.documentId,
          createdJournalEntryId,
        )
      } catch (err) {
        opLog.error('failed to link archived invoice PDF to journal entry', err as Error)
        partialFailures.push({
          step: 'pdf_link',
          reason: 'Fakturans arkiverade PDF kunde inte kopplas till verifikationen.',
        })
      }
    }

    // Gated like the steps above: on a lost race the winning request emits
    // it; on a flip error the row is still 'draft', so emitting would
    // contradict DB state and the retry emits it instead.
    if (statusFlipped && !isCreditNote) {
      await eventBus.emit({
        type: 'invoice.sent',
        payload: { invoice: invoice as Invoice, companyId: companyId!, userId: user.id },
      })
    }

    if (partialFailures.length > 0) {
      opLog.warn('invoice sent with partial follow-up failures', {
        errorCode: 'INVOICE_SEND_PARTIAL',
        failures: partialFailures,
      })
    }

    opLog.info('invoice sent', {
      deliveryId: result.deliveryId,
      messageId: result.messageId,
      recipientCounts: {
        to: recipients.to.length,
        cc: recipients.cc.length,
      },
    })

    return NextResponse.json(
      {
        success: true,
        message: `${isCreditNote ? 'Kreditfakturan' : 'Fakturan'} har skickats till ${customer.email}`,
        messageId: result.messageId,
        deliveryId: result.deliveryId,
        recipient_counts: {
          to: recipients.to.length,
          cc: recipients.cc.length,
        },
        ...(partialFailures.length > 0
          ? { partial: true, partial_failures: partialFailures }
          : {}),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  },
  { requireWrite: true },
)
