/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/credit
 *
 * Issues a credit note (kreditfaktura) against the invoice identified by `:id`.
 * Per ML 17 kap 22-23§, a kreditfaktura references the original invoice's
 * löpnummer and carries reversed-sign amounts.
 *
 * The whole credit is creditInvoice (lib/invoices/credit-invoice.ts), the
 * service the dashboard and the MCP executor use: the guards (a credit note
 * cannot be credited), the period of today checked before anything is
 * written, the credit note mirrored line for line from the original (ROT/RUT,
 * periodisering, override revenue accounts, payee), the reversing verifikat
 * and only then the original flipped to 'credited'. Fail closed: when the
 * verifikat cannot be posted the credit note stays a draft for a retry and
 * the original is untouched. This route parses and maps.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable: under dry-run NO row
 * is created.
 *
 * Optional body: { reason?: string }: populates the credit note's `notes`
 * field. Defaults to "Krediterar faktura <original>".
 */

import { z } from 'zod'
import { created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { CREDIT_NOTE_NOT_DELIVERED, creditInvoice } from '@/lib/invoices/credit-invoice'
import { withAmountToPay, type AmountToPayRow } from '@/lib/invoices/amount-to-pay-fields'

const CreditNoteRequest = z.object({
  reason: z.string().max(2000).optional(),
})

const CREDIT_NOTE_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, ore_rounding, vat_treatment, vat_rate, moms_ruta, vat_treatment_override, delivery_country, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, paid_at, paid_amount, remaining_amount, default_dimensions, created_at, updated_at'

// The issue step's follow-up failures, as response warning codes.
const PARTIAL_FAILURE_WARNING_CODES: Record<string, string> = {
  pdf_archive: 'PDF_ARCHIVE_FAILED',
}

const CreditNoteCreated = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  credited_invoice_id: z.string().uuid(),
  status: z.literal('sent'),
  total: z.number(),
  // What the credit note gives back after öresavrundning, as its PDF prints
  // it (crm#1480, crm#1487): the mirror of the original's amount_to_pay.
  amount_to_pay: z.number(),
  ore_rounding_amount: z.number(),
  // The credited invoice's own rounding choice, frozen at issue.
  ore_rounding: z.boolean().nullable(),
  journal_entry_id: z.string().uuid().nullable(),
  original_journal_entry_id: z.string().uuid().optional(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
})

registerEndpoint({
  operation: 'invoices.credit',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/credit',
  summary: 'Issue a credit note (kreditfaktura) against an invoice.',
  description:
    'Creates and issues a credit note referencing the original invoice. The credit note mirrors the original line for line with reversed-sign amounts (the same VAT, revenue accounts, ROT/RUT and periodisering fields, and payee) and gets invoice_number=KR-<original> (a self-billed original: KR-<its external number>). Posts a reversing journal entry (Debit revenue + Debit output VAT / Credit AR 1510; on ROT/RUT Credit 1513 for Skatteverket\'s share and 1510 for the customer\'s; Debit 29xx where revenue is still deferred, and the accrual schedule stops) whenever the original sale reached the ledger: always under faktureringsmetoden, and under kontantmetoden once the original was paid or otherwise booked (status paid, a linked verifikat, a payment date, or a non-zero paid amount). Only a kontantmetod invoice carrying none of those signals is credited without an entry, because nothing has been recognised yet. Under deferred booking (defer_invoice_booking) an original that was never booked is booked first on its own invoice date, exactly as POST /invoices/{id}/book does (original_journal_entry_id), then credited; when that booking is refused the credit is refused before anything is written (400 INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED or INVOICE_CREDIT_ORIGINAL_BOOK_FAILED). The original transitions to status=credited once the entry exists. The credit note keeps the credited invoice\'s öresavrundning choice (ore_rounding), so its amount_to_pay and ore_rounding_amount mirror the original\'s with the opposite sign whatever the company setting is today. The credit note is dated today (Europe/Stockholm); a locked or closed period, or no fiscal period for today, returns 400 INVOICE_CREDIT_PERIOD_LOCKED before anything is written. Idempotent and dry-runnable. Emits credit_note.created. It delivers nothing and records no delivery: every response carries warning CREDIT_NOTE_NOT_DELIVERED, so fetch GET /invoices/{id}/pdf and send it to the customer yourself.',
  useWhen:
    'You need to legally cancel an issued invoice (ML 17 kap 22-23§). The original invoice cannot be edited once issued: credit it and reissue corrected.',
  doNotUseFor:
    'Cancelling a draft (DELETE the draft instead). Refunding a partial payment without invalidating the whole invoice (book the refund manually via the journal-entries API in a future PR).',
  pitfalls: [
    'Idempotency-Key is mandatory. Retried credits with the same key replay the cached response: no duplicate credit note is created.',
    'The original invoice must be in sent / paid / overdue status. Drafts, cancelled invoices, and already-credited invoices are rejected with specific error codes. A credit note cannot itself be credited (400 INVOICE_CREDIT_NOT_INVOICE).',
    'Fails closed: when the reversing entry cannot be posted the request fails (500 INVOICE_CREDIT_ISSUE_INCOMPLETE with details.failure_steps), the credit note stays a draft and the original is untouched; retry once the cause is fixed and the same credit note is issued. 500 INVOICE_CREDIT_REPAIR_REQUIRED means the entry posted but a later step did not finish: retrying completes it.',
    'Credit-note items mirror the original\'s lines with negated values. To credit only part of an invoice (line-level), credit the full invoice first then reissue with the corrected lines.',
    'Under kontantmetoden a journal entry is posted only when the original carries a booking signal (status paid, a linked verifikat, a payment date, or a non-zero paid amount): crediting an invoice with none of those creates the row without an entry (the deferral is correct, not a failure). Use the dry run to read `would_create_journal_entry` before committing.',
  ],
  example: {
    request: { reason: 'Felaktig kund' },
    response: {
      data: {
        id: 'ccccccc-c…',
        invoice_number: 'KR-2026-0042',
        credited_invoice_id: '0e9c…',
        status: 'sent',
        total: -12500,
        amount_to_pay: -12500,
        ore_rounding_amount: 0,
        ore_rounding: true,
        journal_entry_id: '8b4b…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: CreditNoteRequest },
  response: { success: dataEnvelope(CreditNoteCreated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.credit',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const originalId = idParse.data

    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    // Body is optional. Empty POST is valid (uses default notes).
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

    let reason: string | undefined
    if (rawBody) {
      const parsed = CreditNoteRequest.safeParse(rawBody)
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)
      reason = parsed.data.reason
    }

    const result = await creditInvoice(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      originalId,
      { reason },
      { dryRun: ctx.dryRun },
    )

    if (!result.ok) {
      if (result.code === 'UNKNOWN_ERROR') {
        return v1ErrorResponse(result.error ?? new Error('credit failed'), ctx.log, { requestId: ctx.requestId })
      }
      if (result.failures?.length) {
        ctx.log.error('invoices.credit: issue incomplete', undefined, {
          invoiceId: originalId,
          companyId: ctx.companyId,
          code: result.code,
          failures: result.failures,
        })
      }
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        ...(result.details ? { details: result.details } : {}),
      })
    }

    if (result.dryRun) {
      const [preview] = await withAmountToPay(ctx.supabase, ctx.companyId!, [
        result.preview as unknown as AmountToPayRow,
      ])
      return dryRunPreview(preview, { requestId: ctx.requestId, log: ctx.log })
    }

    const { data: creditNote, error: readErr } = await ctx.supabase
      .from('invoices')
      .select(CREDIT_NOTE_RESPONSE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', result.creditNoteId)
      .single()
    if (readErr || !creditNote) {
      return v1ErrorResponse(readErr ?? new Error('credit note not found after issue'), ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const [withAmounts] = await withAmountToPay(ctx.supabase, ctx.companyId!, [
      creditNote as unknown as AmountToPayRow,
    ])

    const warnings = [
      CREDIT_NOTE_NOT_DELIVERED,
      ...result.partialFailures.map((failure) => ({
        code: PARTIAL_FAILURE_WARNING_CODES[failure.step] ?? 'ISSUE_FOLLOW_UP_FAILED',
        message: failure.reason,
      })),
    ]

    ctx.log.info('invoices.credit success', {
      creditNoteId: result.creditNoteId,
      originalInvoiceId: originalId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      journalEntryId: result.journalEntryId,
      hadWarnings: result.partialFailures.length > 0,
    })

    return created(
      {
        ...withAmounts,
        journal_entry_id: result.journalEntryId,
        ...(result.originalJournalEntryId ? { original_journal_entry_id: result.originalJournalEntryId } : {}),
        warnings,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
