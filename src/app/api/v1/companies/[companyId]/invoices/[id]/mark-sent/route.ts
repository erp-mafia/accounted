/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/mark-sent
 *
 * Transitions a DRAFT invoice to `sent` status. Use this for invoices
 * delivered outside the system (external e-invoice provider, postal,
 * custom email). A successful Peppol send (POST .../invoices/{id}/send-peppol
 * or the dashboard) issues the invoice itself; this endpoint is the
 * documented recovery only when that send was accepted by the network but
 * issuance failed (invoice still draft). The full
 * :send pipeline (PDF + email) will land in PR-B-2b-3.
 *
 * What happens on commit: issueAndBookInvoice, the issue step the dashboard
 * mark-sent and bulk Bokför run, so every door books the same verifikat:
 *   1. The chosen payee is frozen and the payment-account and VAT-number
 *      guards run; then the F-series invoice_number is allocated (ML 17 kap
 *      24§ p.2: only issued invoices consume numbers).
 *   2. Invoice status flips to 'sent' (compare-and-set on draft).
 *   3. If the company books at issue (faktureringsmetoden without
 *      defer_invoice_booking) AND document_type='invoice', the revenue
 *      verifikat is posted from the full items (fakturamodellen: Dr 1510
 *      customer share + Dr 1513 Skatteverket share on ROT/RUT; periodised
 *      lines on 29xx or 17xx with their accrual schedules). When it cannot be
 *      posted the invoice goes back to draft (number kept) and the request
 *      fails. Under kontantmetoden no journal entry is created here.
 *   4. The PDF is archived as underlag, the manual delivery recorded and
 *      invoice.sent emitted.
 *
 * Optional body `paid_at_issue: { account_number }` (crm#1281, the
 * kontantfaktura), the same schema and refusal as the dashboard mark-sent:
 * the invoice is issued already paid, on its fakturadatum, to that 19xx
 * account. Step 3 is then one cash verifikat (Dr 19xx, Cr revenue + output
 * VAT, no 1510) in either accounting method, and the invoice ends paid.
 * issueAndBookInvoice refuses anything but a plain faktura with
 * INVOICE_PAID_AT_ISSUE_NOT_ALLOWED before anything changes.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-run shows the would-be
 * post-send state without allocating a number, posting a journal entry,
 * or emitting events.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { MarkInvoiceSentPaidAtIssueSchema } from '@/lib/api/schemas'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import {
  issuable,
  issueAndBookInvoice,
  lacksMomsRuta,
  type IssuableInvoice,
  type IssuePartialFailure,
} from '@/lib/invoices/issue-and-book-invoice'
import { snapshotInvoicePayee } from '@/lib/invoices/invoice-payee'
import { BUYER_ADDRESS_MISSING_WARNING, invoicePartiesVerdict } from '@/lib/invoices/invoice-parties'
import { paidAtIssueBlockReason } from '@/lib/invoices/paid-at-issue'
import type { CompanySettings, Invoice } from '@/types'

// Explicit projection for the pre-flight, the dry run and the response:
// drops user_id, company_id (internal scoping). The commit books from the
// full row (issueAndBookInvoice), never from this projection.
const INVOICE_MARK_SENT_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, vat_treatment_override, delivery_country, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, paid_at, paid_amount, remaining_amount, default_dimensions, payment_cash_account_id, payment_details, created_at, updated_at'

const InvoiceMarkSentResponse = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  // paid when the body asked for paid_at_issue (a kontantfaktura).
  status: z.enum(['sent', 'paid']),
  total: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  // Present only when the invoice was issued (and, when it books at issue,
  // its verifikat posted) but a follow-up step failed: the PDF archive
  // (PDF_ARCHIVE_FAILED), an accrual schedule (ACCRUAL_SCHEDULES_NOT_CREATED)
  // or the delivery history (DELIVERY_HISTORY_NOT_RECORDED); or when it went
  // out as a förenklad faktura without the buyer's address
  // (BUYER_ADDRESS_MISSING).
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
})

// issueAndBookInvoice's follow-up steps, as response warning codes.
const PARTIAL_FAILURE_WARNING_CODES: Record<string, string> = {
  pdf_archive: 'PDF_ARCHIVE_FAILED',
  accrual_schedules: 'ACCRUAL_SCHEDULES_NOT_CREATED',
  delivery_history: 'DELIVERY_HISTORY_NOT_RECORDED',
}

registerEndpoint({
  operation: 'invoices.mark-sent',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/mark-sent',
  summary: 'Transition a draft invoice to sent (without emailing).',
  description:
    'Marks a draft invoice as sent: for invoices delivered outside Accounted (an external e-invoice provider, postal, manual email). Not needed after a successful Peppol send (POST /invoices/{id}/send-peppol, gnubok_send_invoice_peppol or the dashboard): that flow issues the invoice itself. If a Peppol send reports that the invoice was sent but could not be marked as sent (issuance.ok=false with warning PEPPOL_SENT_NOT_ISSUED, invoice still in draft), :mark-sent is the documented recovery and completes the issuance; a number already allocated is reused, never consumed twice. Peppol sending needs a per-company access grant (POST /peppol/access-request, or Inställningar > Kopplingar > E-faktura via Peppol (Settings > Connections > E-invoicing via Peppol) in the dashboard; check an invoice with GET /invoices/{id}/peppol): senders whose org number is not a personnummer (every legal form except enskild firma), standard invoices only, Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 % only, no ROT/RUT deductions. Allocates the F-series invoice_number atomically (ML 17 kap 24§ p.2). When the company books at issue (faktureringsmetoden without defer_invoice_booking), also posts the invoice journal entry (Debit AR 1510 / Credit revenue + output VAT); under defer_invoice_booking the invoice is marked sent without a verifikat and is booked afterwards with POST /invoices/{id}/book. With body paid_at_issue: { account_number } (a 19xx kassa, bank or Swish account) the invoice is issued already paid, a kontantfaktura: one verifikat on the invoice date, Debit that account / Credit revenue + output VAT, no 1510 leg, in either accounting method, and status ends paid (no :mark-paid afterwards). Emits invoice.sent. Idempotent and dry-runnable. The companion :send action (PR-B-2b-3) adds PDF rendering and email delivery on top of this same flow.',
  useWhen:
    'You delivered the invoice through a channel other than Accounted\'s email or Peppol send (an external e-invoice provider, postal, your own SMTP) and need to record it as sent so the F-series number is allocated and the journal entry is posted; or a Peppol send was accepted by the network but reported that the invoice could not be marked as sent. With paid_at_issue: the customer paid when the invoice was issued (Swish, card, cash at the counter) and the invoice is also the receipt.',
  doNotUseFor:
    'Sending the invoice via Accounted email: use :send (PR-B-2b-3) for that. Marking an already-sent invoice as paid: use :mark-paid (PR-B-2b-2).',
  pitfalls: [
    'Only invoices in `status=draft` can be marked sent. Other states return 409 INVOICE_UPDATE_NOT_DRAFT (re-used; the action is structurally an update).',
    'Allocation is atomic. If a concurrent transition beats the agent\'s request to the same draft, the runner-up gets 409 INVOICE_UPDATE_NOT_DRAFT and no number is consumed.',
    'A delivery note (document_type=delivery_note) keeps its own D-series number: mark-sent books nothing and takes no F-number. It is never emailed, so this is its only way to sent.',
    'A momsfri sale (a company outside the VAT register, vat_treatment=exempt, vat_amount=0) states no moms_ruta. Any other invoice without one, an imported draft, returns 400 VALIDATION_ERROR (details.field moms_ruta): send its items again with PATCH /invoices/{id}, or re-create it.',
    'A faktura states the seller\'s and the buyer\'s name and address (ML 17 kap 24 §). Without the company\'s name or address (company settings) it returns 400 INVOICE_SEND_SELLER_ADDRESS_MISSING; without the customer\'s name or address (street plus postal code or town) 400 INVOICE_SEND_BUYER_ADDRESS_MISSING, unless it may be a förenklad faktura: at most 4 000 kr including VAT, not an EU or reverse-charge sale, or any amount from a seller outside the VAT register. That one is issued with warning BUYER_ADDRESS_MISSING. Both refusals come before a number is allocated.',
    'Idempotency-Key is mandatory. A retried mark-sent with the same key replays the cached response.',
    'Fails closed: when the invoice\'s verifikat cannot be posted (no open or a locked period, a required dimension, an account outside the chart) the invoice stays a draft, keeps any number already allocated, and the request fails with the engine\'s code or 500 INVOICE_MARK_SENT_BOOK_FAILED (details.reason in Swedish). Fix the cause and retry.',
    'paid_at_issue is only for a plain faktura: a proforma or quote (details.reason not_invoice), a självfaktura (self_billed) or an invoice with periodised lines (periodisering) returns 400 INVOICE_PAID_AT_ISSUE_NOT_ALLOWED before anything changes; issue it without paid_at_issue and record the payment with :mark-paid. account_number must be a 19xx account (400 VALIDATION_ERROR otherwise) that exists in the chart. It always settles the full amount on the invoice date: for a partial or later payment, issue without it and use :mark-paid.',
  ],
  example: {
    request: { paid_at_issue: { account_number: resolveAccountRole(PINNED_JURISDICTION, 'bank') } },
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        status: 'sent',
        total: 12500,
        journal_entry_id: '7b3a…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: MarkInvoiceSentPaidAtIssueSchema },
  response: { success: dataEnvelope(InvoiceMarkSentResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.mark-sent',
  async (request, ctx, params) => {
    const { id } = await params.params

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

    // Body is optional: an empty POST issues the invoice as before. The only
    // field is paid_at_issue, the dashboard mark-sent's schema.
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const bodyParse = MarkInvoiceSentPaidAtIssueSchema.safeParse(rawBody ?? {})
    if (!bodyParse.success) return v1ValidationError(ctx, bodyParse.error)
    const paidAtIssue = bodyParse.data.paid_at_issue ?? null

    // Pre-flight: fetch the invoice (with items + customer for the journal-
    // entry generator) and verify it's a draft. is_self_billed and the items'
    // accrual period are what the dry run checks a paid_at_issue against; the
    // customer's address is what issuable reads for the buyer (crm#2080).
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(
        `${INVOICE_MARK_SENT_RESPONSE_COLUMNS}, is_self_billed, customer:customers(id, name, customer_type, country, address_line1, address_line2, postal_code, city, address_state), items:invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, revenue_account, dimensions, accrual_period_start, accrual_period_end)`,
      )
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      ctx.log.warn('invoices.mark-sent: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    const typed = invoice as unknown as Invoice & { customer?: { name?: string } }

    // The document-shape guard runs BEFORE the status check so the returned
    // error matches the documented contract (400 VALIDATION_ERROR for credit
    // notes regardless of their current status; 409 INVOICE_UPDATE_NOT_DRAFT
    // only for genuine invoices).
    //
    // Credit notes (document_type='invoice', a link or a total below zero)
    // need the credit-note journal entry generator (reverses sign of the
    // original invoice). The PR-B-2b-4 :credit endpoint handles them.
    // Reject here so we don't post the wrong-direction journal entry.
    if (isCreditNoteDocument(typed)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'credited_invoice_id',
          message: 'Credit notes are issued via POST /invoices/:id/credit (PR-B-2b-4); they cannot be mark-sent like regular invoices.',
        },
      })
    }

    if (typed.status !== 'draft') {
      return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Company settings in full: the accounting decision, the payment-account
    // and VAT-number guards, and the PDF archived as underlag on commit.
    const { data: settings, error: settingsError } = await ctx.supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (settingsError || !settings) {
      if (settingsError) {
        ctx.log.error('invoices.mark-sent: company settings fetch failed', settingsError as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
      }
      return v1ErrorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', ctx.log, {
        requestId: ctx.requestId,
      })
    }
    const companySettings = settings as CompanySettings

    if (lacksMomsRuta(typed, companySettings)) {
      ctx.log.warn('invoices.mark-sent: missing moms_ruta', {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'moms_ruta',
          message: 'Invoice has no moms_ruta set. The customer\'s VAT rule must be applied: send its items with PATCH /invoices/{id} or re-create it via POST /invoices.',
        },
      })
    }

    const accountingMethod = companySettings.accounting_method ?? 'accrual'
    const isRealInvoice = !typed.document_type || typed.document_type === 'invoice'
    // #967: kontantmetoden and defer_invoice_booking companies mark sent
    // WITHOUT booking (same gate as the dashboard, issue-and-book-invoice.ts).
    const wouldCreateJournalEntry = isRealInvoice && booksInvoicesOnIssue(companySettings)

    if (ctx.dryRun) {
      // The guards the commit runs before it takes a number, in its order
      // (issueAndBookInvoice), without persisting the payee snapshot.
      if (paidAtIssue) {
        const reason = paidAtIssueBlockReason(typed)
        if (reason) {
          return v1ErrorResponseFromCode('INVOICE_PAID_AT_ISSUE_NOT_ALLOWED', ctx.log, {
            requestId: ctx.requestId,
            details: { reason },
          })
        }
      }
      const payeeSnapshot = await snapshotInvoicePayee(ctx.supabase, ctx.companyId!, typed, { persist: false })
      if (!payeeSnapshot.ok) {
        return v1ErrorResponseFromCode(payeeSnapshot.code, ctx.log, {
          requestId: ctx.requestId,
          details: payeeSnapshot.details,
        })
      }
      typed.payment_details = payeeSnapshot.payee
      const refused = issuable(typed, companySettings)
      if (refused) {
        return v1ErrorResponseFromCode(refused.code, ctx.log, {
          requestId: ctx.requestId,
          details: refused.details,
        })
      }
      // Preview the post-send state. invoice_number can't be predicted
      // exactly (atomic sequence allocation); show a marker so the agent
      // knows commit will assign one. A kontantfaktura always books its one
      // cash verifikat, whatever the method or deferral.
      return dryRunPreview(
        {
          ...typed,
          status: paidAtIssue ? ('paid' as const) : ('sent' as const),
          invoice_number: typed.invoice_number ?? '(allocated atomically on commit)',
          would_create_journal_entry: paidAtIssue ? true : wouldCreateJournalEntry,
          accounting_method: accountingMethod,
          ...(paidAtIssue
            ? { paid_at_issue: { account_number: paidAtIssue.account_number, payment_date: typed.invoice_date } }
            : {}),
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Commit: the dashboard's issue step, from the full row. Every item column
    // the booking builders read is there: without deduction_type/_amount a
    // ROT/RUT invoice books Dr 1510 for the full total and no 1513, without
    // accrual_* a periodised line books on 30xx with no schedule.
    const { data: bookingRow, error: bookingFetchErr } = await ctx.supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()
    if (bookingFetchErr) {
      return v1ErrorResponse(bookingFetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!bookingRow) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    const issued = await issueAndBookInvoice({
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      userId: ctx.userId,
      invoice: bookingRow as IssuableInvoice,
      settings: companySettings,
      log: ctx.log,
      // Refused there (INVOICE_PAID_AT_ISSUE_NOT_ALLOWED) for anything but a
      // plain faktura, as on the dashboard; a refused payment answers below
      // with settleInvoicePayment's own code.
      paidAtIssue: paidAtIssue ? { settlementAccountNumber: paidAtIssue.account_number } : null,
    })
    if (!issued.ok) {
      switch (issued.errorCode) {
        case 'INVOICE_MARK_SENT_RACE':
          // Another request issued the draft between the pre-flight and the
          // compare-and-set.
          return v1ErrorResponseFromCode('INVOICE_UPDATE_NOT_DRAFT', ctx.log, {
            requestId: ctx.requestId,
            details: { reason: 'Invoice transitioned out of draft during mark-sent.' },
          })
        case 'INVOICE_MARK_SENT_STATUS_FAILED':
          return v1ErrorResponseFromCode('INVOICE_SEND_PROVIDER_FAILED', ctx.log, {
            requestId: ctx.requestId,
          })
        case 'INVOICE_CREATE_NUMBER_ASSIGN_FAILED':
          return v1ErrorResponseFromCode('INVOICE_SEND_NUMBER_ASSIGN_FAILED', ctx.log, {
            requestId: ctx.requestId,
            ...(issued.details ? { details: issued.details } : {}),
          })
        case 'INVOICE_MARK_SENT_BOOK_FAILED':
          // Fail closed: the invoice is back in draft with its number.
          // The engine's own refusal answers with its code.
          if (isBookkeepingError(issued.bookingError)) {
            return v1ErrorResponse(issued.bookingError, ctx.log, { requestId: ctx.requestId })
          }
          return v1ErrorResponseFromCode('INVOICE_MARK_SENT_BOOK_FAILED', ctx.log, {
            requestId: ctx.requestId,
            ...(issued.reason ? { details: { reason: issued.reason } } : {}),
          })
        default:
          return v1ErrorResponseFromCode(issued.errorCode, ctx.log, {
            requestId: ctx.requestId,
            ...(issued.details ? { details: issued.details } : {}),
          })
      }
    }
    const journalEntryId = issued.journalEntryId

    // The response is the row as stored (number, status, frozen payee).
    const { data: stored } = await ctx.supabase
      .from('invoices')
      .select(INVOICE_MARK_SENT_RESPONSE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()
    const updated = stored ?? {
      ...typed,
      status: paidAtIssue ? ('paid' as const) : ('sent' as const),
      invoice_number: (bookingRow as Invoice).invoice_number,
    }

    // A follow-up step that failed after the issue committed.
    const warnings = issued.partialFailures.map((failure: IssuePartialFailure) => ({
      code: PARTIAL_FAILURE_WARNING_CODES[failure.step] ?? 'ISSUE_FOLLOW_UP_FAILED',
      message: failure.reason,
    }))
    // A förenklad faktura issued without the buyer's address (crm#2080).
    if (invoicePartiesVerdict(bookingRow as Invoice, (bookingRow as IssuableInvoice).customer, companySettings) === 'buyer_missing_simplified') {
      warnings.push({ code: BUYER_ADDRESS_MISSING_WARNING.code, message: BUYER_ADDRESS_MISSING_WARNING.message_sv })
    }

    ctx.log.info('invoices.mark-sent success', {
      invoiceId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      invoiceNumber: (updated as { invoice_number?: string | null }).invoice_number,
      journalEntryId,
      paidAtIssue: !!paidAtIssue,
      hadWarnings: warnings.length > 0,
    })

    return ok(
      {
        ...(updated as object),
        journal_entry_id: journalEntryId,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
