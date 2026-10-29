/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-supplier-invoice
 *
 * Match a negative (expense) bank transaction to an open supplier invoice.
 * Books through the dashboard route's own function (bookSupplierBankMatch),
 * so the same payment gives the same verifikat and ledger update on both
 * doors, and a bank row that is already booked is refused on both
 * (MATCH_SI_TX_ALREADY_BOOKED) unless the caller asks, with storno_existing,
 * to reverse the row's own categorization. A deferring company's unbooked
 * invoice (defer_invoice_booking) is booked first by the Bokför step
 * (lib/supplier-invoices/registration-first.ts), as on the dashboard door.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { bookSupplierBankMatch } from '@/lib/invoices/book-supplier-bank-match'
import type { SupplierInvoice } from '@/types'

const MatchSIResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  bank_fee_sek: z.number(),
  /** The registration verifikat this match booked first (defer_invoice_booking), else null. */
  registration_journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'transactions.match-supplier-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-supplier-invoice',
  summary: 'Match a negative bank transaction to a supplier invoice.',
  description:
    'Confirms a supplier invoice payment match. Creates the payment journal entry (accrual: 2440 debit, credit on the transaction\'s own settlement account, 1930 when unlinked; cash-method: collapsed registration+payment), updates supplier_invoices, inserts a supplier_invoice_payments row, and links the transaction. Handles FX differences for cross-currency payments (7960 gain / 3960 loss), a bank fee paid on top of the invoice (6570) and öresavrundning on a whole-krona SEK payment (3740). Same payment plan and verifikat as the dashboard match.',
  useWhen:
    'You have a bank payment and a known open supplier invoice. The transaction must be negative (expense) and not yet booked.',
  doNotUseFor:
    'Categorizing a direct supplier expense without an invoice: use `:categorize`. Matching to a customer invoice: use `:match-invoice`. Bulk auto-match: `POST /reconciliation/bank/run`.',
  pitfalls: [
    'Cash-method companies can settle a foreign invoice in full (booked at the payment-date rate); only a PARTIAL cash-method payment across currencies is rejected (MATCH_SI_CASH_FX_UNSUPPORTED): pay in full, switch to accrual, or book manually.',
    'Öresavrundning (both accounting methods): a SEK bank row less than 1 kr off the remaining balance of a SEK invoice (a whole-krona payment of an öre total) settles it in full. The payment account is credited with the bank amount and the residual is booked on 3740 (no VAT); paid_amount records the debt settled, not the cash moved. A shortfall of 1 kr or more is a partial payment (on a never-booked cash-method invoice it returns SI_CASH_PARTIAL_UNSUPPORTED).',
    'Bank fee on top: a same-currency row that pays more than the remaining balance settles the invoice in full; 2440 is cleared by the remaining balance only and the excess (up to 5 000 kr) is booked on 6570 and returned as bank_fee_sek (0 when there is none, and always 0 with custom lines, which book what they say). paid_amount never exceeds the invoice total. Check bank_fee_sek: a large one usually means the row pays another invoice too.',
    'A same-currency excess above the fee cap returns 400 MATCH_SI_AMOUNT_EXCEEDS_REMAINING and books nothing: allocate the payment across several invoices with POST /transactions/{id}/match-batch. Like every refusal, it runs before a categorization is reversed with storno_existing. A cross-currency match is not capped: it settles the remaining balance and books the whole SEK difference as kursdifferens (7960/3960).',
    'Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): a supplier invoice registered without its verifikat is booked first by the supplier-invoices :book step (Debit cost + 2641 / Credit 2440, dated on the invoice date), then the payment clears that 2440; registration_journal_entry_id names it (null when nothing was booked first). When the book step refuses (invoice date in a locked period PERIOD_LOCKED, no fiscal year SI_BOOK_NO_FISCAL_PERIOD, a locked accrual month SI_ACCRUED_COST_PERIOD_LOCKED, a partially paid invoice SI_BOOK_INVALID_STATUS), the match is refused with that code, details.registration_first is true, and nothing is booked or reversed.',
    'A transaction that is already booked is refused with 409 MATCH_SI_TX_ALREADY_BOOKED and nothing is written: its pointer or a bank_line link names a posted verifikat, or it is linked to an existing verifikat. details names it (journal_entry_id, voucher, via: pointer, link, reconciliation, read_error, or concurrent when another booking took the transaction first). When details.storno_allowed is true the booking is the transaction\'s own categorization: resend with storno_existing: true to reverse it (storno) and book the payment, after every other check has passed. A samlingsverifikat, a split or a reconciliation link is never reversed here: unlink or correct it first. Before 2026-10-28 this endpoint reversed a categorization without being asked and re-pointed a reconciliation link.',
    'Transaction must be negative (amount < 0). Positive returns MATCH_SI_NOT_EXPENSE.',
    'Supplier invoice must NOT be paid/credited already. paid/credited returns MATCH_SI_ALREADY_PAID; registered/approved/partially_paid/overdue are matchable.',
    'Idempotency-Key is mandatory.',
  ],
  example: {
    request: { supplier_invoice_id: 'si_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 5000,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
        bank_fee_sek: 0,
        registration_journal_entry_id: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchSupplierInvoiceSchema },
  response: { success: dataEnvelope(MatchSIResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-supplier-invoice',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }
    const txId = idParse.data

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = MatchSupplierInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { supplier_invoice_id, lines: customLines, storno_existing } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, supplierInvoiceId: supplier_invoice_id })

    const { data: transaction, error: fetchTxErr } = await ctx.supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchTxErr || !transaction) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    if (transaction.amount >= 0) {
      return v1ErrorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId: ctx.requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.supplier_invoice_id) {
      return v1ErrorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId: ctx.requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }

    const { data: invoice, error: fetchInvErr } = await ctx.supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchInvErr || !invoice) {
      return v1ErrorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    if (invoice.status === 'paid' || invoice.status === 'credited') {
      return v1ErrorResponseFromCode('MATCH_SI_ALREADY_PAID', txLog, {
        requestId: ctx.requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // The booking is the dashboard door's own function (bookSupplierBankMatch):
    // the booked-row gate, the payment plan, the registration a deferring
    // company books first, the verifikat, the row claim, the ledger update,
    // the payment row, the log and the events. This door used to keep its own
    // copy, which reversed a categorization without being asked and re-pointed
    // a reconciliation-linked row (accounted#58).
    const outcome = await bookSupplierBankMatch(ctx.supabase, {
      transaction,
      invoice: invoice as SupplierInvoice,
      userId: ctx.userId,
      companyId: ctx.companyId!,
      log: txLog,
      customLines,
      match: { action: 'matched', method: 'manual_confirm', confidence: 1.0 },
      // The caller named this bank line for this invoice; on an API key the
      // request scope records client_asserted.
      linkBasis: { basis: 'user_confirmed' },
      stornoExisting: storno_existing,
    })
    if (!outcome.ok) {
      if (outcome.error !== undefined) return v1ErrorResponse(outcome.error, txLog, { requestId: ctx.requestId })
      return v1ErrorResponseFromCode(outcome.code, txLog, { requestId: ctx.requestId, details: outcome.details })
    }

    return ok(
      {
        success: true,
        invoice_status: outcome.plan.newStatus,
        paid_amount: outcome.plan.newPaidAmount,
        remaining_amount: outcome.plan.newRemaining,
        journal_entry_id: outcome.journalEntryId,
        // No preview on this door: the caller learns here what went to 6570.
        // Custom lines book what they say, so the plan's fee is not theirs.
        bank_fee_sek: customLines ? 0 : outcome.plan.bankFeeSek,
        registration_journal_entry_id: outcome.registrationJournalEntryId,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
