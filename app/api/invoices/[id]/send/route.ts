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
import { applyPaymentLinkToInvoice } from '@/lib/extensions/payment-links'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { Invoice, InvoiceItem, Customer, CompanySettings } from '@/types'

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

    // A cancelled invoice keeps its F-series number for compliance with ML 17
    // kap 24§ but is not a valid faktura: sending it would silently
    // re-activate it (the .update({ status: 'sent' }) below has no status
    // guard) and could deliver a "MAKULERAD" PDF as if it were live.
    if (invoice.status === 'cancelled') {
      return errorResponseFromCode('INVOICE_SEND_CANCELLED', opLog, { requestId })
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

    let originalInvoiceNumber: string | undefined
    if (invoice.credited_invoice_id) {
      const { data: originalInvoice } = await supabase
        .from('invoices')
        .select('invoice_number')
        .eq('id', invoice.credited_invoice_id)
        .eq('company_id', companyId)
        .single()

      if (originalInvoice) {
        originalInvoiceNumber = originalInvoice.invoice_number
      }
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
    const { failure: paymentLinkFailure } = await applyPaymentLinkToInvoice(
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
      invoice: invoice as Invoice,
      customer,
      company: company as CompanySettings,
    }

    const isCreditNote = !!invoice.credited_invoice_id
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
        details: { providerError: result.error },
      })
    }

    // From here on the invoice has reached the customer. Failures in the
    // follow-up steps degrade the response to PARTIAL: the user gets a
    // success toast with a sub-warning, and the audit trail records exactly
    // which sub-step broke.
    const partialFailures: Array<{ step: string; reason: string }> = []

    if (paymentLinkFailure) {
      partialFailures.push({ step: 'payment_link', reason: paymentLinkFailure })
    }

    {
      const { error: updateError } = await supabase
        .from('invoices')
        .update({ status: 'sent' })
        .eq('id', id)
        .eq('company_id', companyId)

      if (updateError) {
        opLog.warn('failed to update invoice status to sent', updateError)
        partialFailures.push({ step: 'status_update', reason: updateError.message })
      }
    }

    const isRealInvoice = !invoice.document_type || invoice.document_type === 'invoice'
    const accountingMethod = (company as Record<string, unknown>).accounting_method as string | undefined
    let createdJournalEntryId: string | undefined

    if (isRealInvoice && (!accountingMethod || accountingMethod === 'accrual')) {
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
          reason: err instanceof Error ? err.message : 'unknown',
        })
      }
    }

    if (isRealInvoice) {
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
          reason: err instanceof Error ? err.message : 'unknown',
        })
      }
    }

    await eventBus.emit({
      type: 'invoice.sent',
      payload: { invoice: invoice as Invoice, companyId: companyId!, userId: user.id },
    })

    if (partialFailures.length > 0) {
      opLog.warn('invoice sent with partial follow-up failures', {
        errorCode: 'INVOICE_SEND_PARTIAL',
        failures: partialFailures,
      })
    }

    return NextResponse.json({
      success: true,
      message: `Fakturan har skickats till ${customer.email} (kopia till ${ccAddress})`,
      messageId: result.messageId,
      ...(partialFailures.length > 0
        ? { partial: true, partial_failures: partialFailures }
        : {}),
    })
  },
  { requireWrite: true },
)
