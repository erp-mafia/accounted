/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-invoice
 *
 * Match a positive (income) transaction to an open customer invoice. The
 * booking is bookCustomerBankMatch, the dashboard door's own function: the
 * guards, the sale a deferring company books first, the payment verifikat on
 * the row's own bank account, the row and invoice compare-and-sets, the
 * payment row, the invoice PDF, the log and the events. Two doors, one
 * ledger.
 *
 * A transaction that is already booked or ignored is refused, nothing is
 * reversed here: the caller undoes the booking first (details.undo says how).
 *
 * Idempotent on (transaction, key). NOT dry-runnable: the multi-row interlock
 * makes a meaningful preview infeasible without staging the JE for real.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { bookCustomerBankMatch } from '@/lib/invoices/book-customer-bank-match'
import { v1OutcomeResponse } from '@/lib/operations/v1'

const MatchInvoiceResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_at: z.string().nullable(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  sale_journal_entry_id: z
    .string()
    .uuid()
    .optional()
    .describe('The sale verifikat this match booked first (defer_invoice_booking); absent when none was booked.'),
  // Preserved from the prior :categorize call (or whatever the existing
  // value was). Returns null when the transaction had never been
  // categorized: the v1 surface no longer guesses 'income_services'
  // for unmatched-revenue rows because the wrong default flows into
  // BAS 3001/3041/3530 selection and INK2R/SRU reporting.
  category: z.string().nullable(),
})

registerEndpoint({
  operation: 'transactions.match-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-invoice',
  summary: 'Match a positive bank transaction to a customer invoice.',
  description:
    'Confirms an invoice match for a transaction. Creates the payment journal entry, links the transaction, updates the invoice status (paid / partially_paid) and inserts into invoice_payments. A transaction that is already booked is refused, never reversed here. Idempotent.',
  useWhen:
    'You have a bank receipt and a known open invoice it pays. The transaction must be positive (income), unbooked and not ignored.',
  doNotUseFor:
    'Categorizing a transaction without an invoice: use `:categorize`. Matching to a supplier invoice: use `:match-supplier-invoice`. Bulk auto-match: use `POST /reconciliation/bank/run`.',
  pitfalls: [
    'Proforma + delivery notes are rejected (MATCH_INVOICE_NOT_INVOICE_TYPE): only document_type=\'invoice\' can be matched.',
    'Transaction must be positive (amount > 0): negative transactions return MATCH_INVOICE_NOT_INCOME.',
    'Invoice must be in sent / overdue / partially_paid status: paid or draft invoices return MATCH_INVOICE_NOT_OPEN. An invoice with an active credit note returns MATCH_INVOICE_CREDIT_NOTE.',
    'A transaction that is already booked returns 409 MATCH_INVOICE_TX_ALREADY_BOOKED and nothing is written: its pointer or a bank_line link names a posted verifikat, it is linked to an existing verifikat, or a posted verifikat was booked from it without being linked to it. details names it (journal_entry_id, voucher, via: pointer, link, reconciliation, named for that last case, or concurrent when another booking took the transaction first) and says in undo how to open the transaction: uncategorize (POST /transactions/{id}/uncategorize), unlink (the reconciliation unlink: the verifikat stays posted) or reverse_voucher (a storno of the verifikat, which releases every transaction on it). On via named, when the verifikat is the booking of this transaction, link the two instead (POST /transactions/{id}/link-journal-entry). If the verifikat already is this payment, do not match: link the invoice to it (gnubok_link_invoice_to_voucher, or the invoice page). Before 2026-11-01 this endpoint reversed a categorization without being asked and booked a second verifikat on a transaction booked through a voucher link.',
    'An ignored transaction returns 409 BANK_ROW_IGNORED: restore it first (DELETE /transactions/{id}/ignore).',
    'A failed read of the transaction returns 503 BANK_ROW_READ_FAILED: nothing was booked, retry the same request.',
    'Kontantmetoden: an invoice never booked at issue is matched only by one payment of its whole amount. A partial payment, or the final payment of an invoice already part-paid, returns INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED (details.reason partial_payment | previously_partially_paid); book that payment as a manual journal entry.',
    'Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an invoice sent without its verifikat is booked first by the invoices :book step (dated on the invoice date), then the payment clears that 1510; sale_journal_entry_id names it. When the book step refuses (PERIOD_LOCKED on the invoice date, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_INVALID_STATUS for a partially paid invoice) or the transaction date is locked (PERIOD_LOCKED with details.payment_date), the match is refused with that code, details.sale_first is true, and nothing is booked.',
    'Idempotency-Key is mandatory.',
  ],
  example: {
    request: { invoice_id: 'inv_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 12500,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
        category: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchInvoiceSchema },
  response: { success: dataEnvelope(MatchInvoiceResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-invoice',
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
    const parsed = MatchInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { invoice_id, force, expected_journal_entry_id, lines, manual_exchange_rate } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, invoiceId: invoice_id })

    // The booking is the dashboard door's own function: this route used to
    // keep its own 800-line copy of it (accounted#58).
    const outcome = await bookCustomerBankMatch(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: txLog },
      {
        transactionId: txId,
        invoiceId: invoice_id,
        customLines: lines,
        manualExchangeRate: manual_exchange_rate,
        force,
        expectedJournalEntryId: expected_journal_entry_id,
        overrideVia: 'v1_force',
      },
    )
    if (!outcome.ok) return v1OutcomeResponse(outcome, ctx)

    return ok(
      {
        success: true,
        invoice_status: outcome.invoiceStatus,
        paid_at: outcome.paidAt,
        paid_amount: outcome.paidAmount,
        remaining_amount: outcome.remainingAmount,
        journal_entry_id: outcome.journalEntryId,
        ...(outcome.saleJournalEntryId ? { sale_journal_entry_id: outcome.saleJournalEntryId } : {}),
        category: outcome.category,
      },
      {
        requestId: ctx.requestId,
        ...(outcome.saleWarnings.length > 0 ? { warnings: outcome.saleWarnings } : {}),
      },
    )
  },
  { requireIdempotencyKey: true },
)
