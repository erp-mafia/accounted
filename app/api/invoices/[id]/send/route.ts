import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender, buildSwishQrDataUrl, buildPaymentLinkQrDataUrl } from '@/lib/invoices/pdf-render-helpers'
import { getEmailService } from '@/lib/email/service'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { createSchedulesForCustomerInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import {
  issueCreditNote,
  type CreditNoteOriginalInvoice,
} from '@/lib/invoices/issue-credit-note'
import { applyPaymentLinkToInvoice } from '@/lib/extensions/payment-links'
import { withRouteContext } from '@/lib/api/with-route-context'
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
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

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

    const customer = invoice.customer as Customer
    if (!customer.email) {
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

    const items = (invoice.items as InvoiceItem[]).sort((a, b) => a.sort_order - b.sort_order)

    let originalInvoice: CreditNoteOriginalInvoice | undefined
    let originalInvoiceNumber: string | undefined
    if (invoice.credited_invoice_id) {
      const { data: original } = await supabase
        .from('invoices')
        .select('id, invoice_number, status, journal_entry_id, paid_at, paid_amount, total')
        .eq('id', invoice.credited_invoice_id)
        .eq('company_id', companyId)
        .single()

      if (!original) {
        return errorResponseFromCode('INVOICE_CREDIT_ORIGINAL_NOT_FOUND', opLog, { requestId })
      }

      originalInvoice = original as CreditNoteOriginalInvoice
      originalInvoiceNumber = original.invoice_number ?? undefined
    }

    // Preflight render: validate the PDF pipeline BEFORE consuming an F-series
    // number. If the row is already numbered (retry path), skip: we'd just
    // render twice for no gain.
    const isFreshAllocation = !invoice.invoice_number
    if (isFreshAllocation) {
      try {
        const preflight = await prepareInvoicePdfRender(company as CompanySettings)
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
    )
    const swishQrDataUrl = await buildSwishQrDataUrl(company as CompanySettings, renderableInvoice)
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

    const docType = invoice.document_type || 'invoice'
    let filename: string
    if (isCreditNote) {
      filename = `kreditfaktura-${invoice.invoice_number}.pdf`
    } else if (docType === 'proforma') {
      filename = `proformafaktura-${invoice.invoice_number}.pdf`
    } else if (docType === 'delivery_note') {
      filename = `foljesedel-${invoice.invoice_number}.pdf`
    } else {
      filename = `faktura-${invoice.invoice_number}.pdf`
    }

    const ccAddress = company.email || user.email
    const partialFailures: Array<{ step: string; reason: string }> = []
    if (paymentLinkFailure) {
      partialFailures.push({ step: 'payment_link', reason: paymentLinkFailure })
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

    const result = await emailService.sendEmail({
      to: customer.email,
      cc: ccAddress,
      subject: generateInvoiceEmailSubject(emailData),
      html: generateInvoiceEmailHtml(emailData),
      text: generateInvoiceEmailText(emailData),
      replyTo: company.email || undefined,
      fromName: company.company_name,
      attachments: [
        {
          filename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    })

    if (!result.success) {
      opLog.error('email provider failed to send invoice', new Error(result.error || 'Unknown'))
      return errorResponseFromCode('INVOICE_SEND_PROVIDER_FAILED', opLog, {
        requestId,
        details: { retryable: true },
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
        partialFailures.push({ step: 'status_update', reason: updateError.message })
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
    const accountingMethod = ((company as Record<string, unknown>).accounting_method || 'accrual') as AccountingMethod
    let createdJournalEntryId: string | undefined = creditJournalEntryId ?? undefined

    if (statusFlipped && !isCreditNote && isRealInvoice && accountingMethod === 'accrual') {
      try {
        const journalEntry = await createInvoiceJournalEntry(
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
      } catch (err) {
        opLog.error('failed to create invoice journal entry on send', err as Error)
        partialFailures.push({
          step: 'journal_entry',
          reason: 'Fakturans verifikat kunde inte skapas.',
        })
      }
    }

    if (statusFlipped && isRealInvoice) {
      try {
        const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
        await uploadDocument(supabase, user.id, companyId!, {
          name: filename,
          buffer: pdfArrayBuffer,
          type: 'application/pdf',
        }, {
          upload_source: 'system',
          journal_entry_id: createdJournalEntryId,
        })
      } catch (err) {
        opLog.error('failed to store invoice PDF as underlag', err as Error)
        partialFailures.push({
          step: 'pdf_archive',
          reason: 'Fakturans PDF kunde inte arkiveras.',
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

    return NextResponse.json({
      success: true,
      message: `${isCreditNote ? 'Kreditfakturan' : 'Fakturan'} har skickats till ${customer.email} (kopia till ${ccAddress})`,
      messageId: result.messageId,
      ...(partialFailures.length > 0
        ? { partial: true, partial_failures: partialFailures }
        : {}),
    })
  },
  { requireWrite: true },
)
