/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/mark-paid
 *
 * Records a payment against a supplier invoice. The rules and the booking are
 * lib/invoices/settle-supplier-payment.ts, shared with the dashboard door; this
 * route owns the request, the one rule of the public API (a foreign payment
 * states its SEK) and the response.
 *
 * The credited payment account is `payment_account` when the body names one,
 * otherwise the company's primary bank account: the same resolution the
 * dashboard route uses, in planSupplierSettlement. Issue #2550: this door
 * accepted the field in its schema but dropped it on the floor, so every API
 * payment landed on 1930 no matter what the caller asked for.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import {
  bookSupplierSettlement,
  planSupplierSettlement,
  supplierSettlementInput,
  type SettleableSupplierInvoice,
  type SupplierSettlementInput,
} from '@/lib/invoices/settle-supplier-payment'
import { v1OutcomeResponse } from '@/lib/operations/v1'

const SI_PAID_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, status, currency, total, paid_amount, remaining_amount, paid_at, payment_journal_entry_id, registration_journal_entry_id'

const SupplierInvoicePaidResponse = z.object({
  id: z.string().uuid(),
  status: z.enum(['paid', 'partially_paid']),
  total: z.number(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  payment_journal_entry_id: z.string().uuid().nullable(),
  registration_journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'supplier-invoices.mark-paid',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/mark-paid',
  summary: 'Record a payment against a supplier invoice.',
  description:
    'Books the payment journal entry (Debit 2440 / Credit the payment account under accrual; or Debit expense + Debit 2641 / Credit the payment account under cash) and flips the SI status to `paid` (full settlement) or `partially_paid`. The payment account is `payment_account` when supplied, otherwise 1930 Företagskonto. A booking failure leaves the SI unchanged. Idempotent. Dry-runnable.',
  useWhen:
    'You paid a registered or approved leverantörsfaktura through a channel other than the synced bank flow. For bank-matched payments use POST /transactions/{id}/match-supplier-invoice instead: that path also reconciles the bank line.',
  doNotUseFor:
    'Refunding a payment (the public API does not expose unmark-paid; credit the SI instead). Paying a credited or already-paid SI (returns 409 SI_PAID_ALREADY). Paying a credit note (returns 400 SI_PAID_NOT_PAYABLE with details.reason credit_note).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'amount above what the SI still owes returns 400 MATCH_SI_AMOUNT_EXCEEDS_REMAINING with details.remaining_amount and details.excess, and books nothing. Issue a credit note via :credit for over-billing, or book a refund through the transactions endpoints.',
    'payment_date after today (Swedish calendar day) returns 400 PAYMENT_DATE_IN_FUTURE: a payment is booked on the day the money moved.',
    'payment_date must fall in an open fiscal period: locked period returns 400 SI_PAID_PERIOD_LOCKED.',
    'Foreign-currency SIs under accrual: amount is in the invoice currency and the verifikat is in SEK. The SEK cleared off 2440 is read from the ledger (the registration verifikat minus earlier payments), never computed by the caller; an SI with no registration verifikat (migrated) clears at its own exchange_rate, and one with no rate either returns 400 SI_FX_RATE_MISSING. State what the payment cost in SEK with amount_sek (the SEK that left the payment account; the difference to the cleared SEK books on 3960 gain / 7960 loss) or with exchange_rate_difference (cleared SEK minus paid SEK; 0 for none). One of the two is required, not both.',
    'Foreign-currency SI whose linked vouchers contradict each other (a batch voucher shared with another invoice, payment rows that do not add up to paid_amount, a registration or payment voucher reversed with no single correction), or whose 2440 balance is more than 10% away from remaining_amount x exchange_rate (reason ledger_rate_mismatch: the registration was corrected for something other than the rate), or whose history is longer than one request resolves (reason ledger_history_too_long: more than 50 payment rows or 20 storno hops), returns 409 SI_PAID_SEK_UNRESOLVED with details.reason and books nothing. Check the SEK against the ledger and resend with explicit SEK lines.',
    'Kontantmetoden company paying an SI that was registered on 2440 (booked at receipt, before a switch of method): the payment clears 2440 like under faktureringsmetoden, so a foreign-currency one needs amount_sek or exchange_rate_difference too. Only an SI never registered gets the cash entry (expense + ingående moms at payment).',
    'Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an SI registered without its verifikat is booked first by the :book step (Debit cost + 2641 / Credit 2440, dated on the invoice date, periodiseringar included), then the payment clears that 2440. registration_journal_entry_id in the response names it, and the dry run returns it as registration_journal_entry. When the book step refuses (invoice date in a locked period PERIOD_LOCKED, no fiscal year SI_BOOK_NO_FISCAL_PERIOD, a locked accrual month SI_ACCRUED_COST_PERIOD_LOCKED, a partially paid SI SI_BOOK_INVALID_STATUS), the payment is refused with that code, details.registration_first is true, and nothing is booked.',
    'A failure while booking changes nothing: a voucher left without its payment row or status is cancelled and its number documented as a gap (500 SI_PAID_FAILED). Retry the call.',
    'Cash basis (kontantmetoden) recognizes the expense + ingående moms HERE, not at :create.',
    'Cash basis + öresavrundning: a SEK invoice with ore_rounding on and an öre-bearing total is paid in whole kronor, so the generated entry credits the payment account with the rounded amount and books the residual on 3740 (no VAT). amount, paid_amount and remaining_amount stay in exact öre. Invoices whose rounding is already an invoice row on 3740 have a whole-krona total and are unaffected.',
    'payment_account picks the BAS account credited for the payment (the company\'s primary bank account when omitted, on both the accrual and the cash path). It must be active in the chart of accounts: an unknown or deactivated account returns 400 ACCOUNTS_NOT_IN_CHART and books nothing. Beyond that it is credited exactly as given, with no range check: 19xx bank or kassa is the ordinary choice, but 1630 (betald via skattekontot) and 2893 / 2018 / 2820 (someone else paid, utlägg) are equally valid, so choosing an account that does not represent where the money actually came from is the caller\'s error to avoid. Unlike the dashboard dialog, this endpoint does not read the company\'s last-used payment account: omitting the field always means the primary bank account.',
    'An invoice with a bank payment order that is signed or being signed (awaiting_signature, awaiting_second_signer, accepted) returns 409 SI_BANK_PAYMENT_UNDER_WAY, also under dry-run and with no force: the bank still pays it. Let that payment settle the invoice, or cancel the order first; once the money has left, match its bank row to the invoice instead.',
    'Duplicate-payment guard: on a full settlement, if a business bank transaction of the same amount around payment_date carries the supplier name (first distinctive token, so abbreviated bank text such as "HI3G" for Hi3G Access AB counts), returns 409 SI_PAID_LIKELY_DUPLICATE with candidate transactions. A candidate with match_reason `already_booked` is a bank row that is ALREADY a verifikat: do not pay the invoice, correct the double booking instead. Retry with `force: true` only after the user confirms, and with a fresh Idempotency-Key (the original is body-hash bound). Also evaluated under dry-run. A forced full settlement is recorded in behandlingshistorik together with the candidates the guard would have flagged.',
  ],
  example: {
    request: { payment_date: '2026-05-13' },
    response: {
      data: {
        id: '0e9c…',
        status: 'paid',
        total: 1250,
        paid_amount: 1250,
        remaining_amount: 0,
        paid_at: '2026-05-13',
        payment_journal_entry_id: '7b3a…',
        registration_journal_entry_id: '5d1f…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: MarkSupplierInvoicePaidSchema },
  response: { success: dataEnvelope(SupplierInvoicePaidResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.mark-paid',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    // Body is optional: empty POST = pay the full remaining_amount today.
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

    let input: SupplierSettlementInput = {}
    if (rawBody) {
      const parsed = MarkSupplierInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)
      input = supplierSettlementInput(parsed.data)
    }

    // Fetch SI with supplier + items (needed by the engine for cash-basis).
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('supplier_invoices')
      .select(`
        id, supplier_id, status, currency, exchange_rate, total, paid_amount, remaining_amount,
        supplier_invoice_number, arrival_number, invoice_date, vat_treatment, reverse_charge, reverse_charge_kind, payment_reference,
        subtotal, subtotal_sek, vat_amount, vat_amount_sek, total_sek, due_date, received_date,
        is_credit_note, credited_invoice_id, payment_journal_entry_id, registration_journal_entry_id, default_dimensions,
        supplier:suppliers(id, name, supplier_type),
        items:supplier_invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate, apply_slp, dimensions)
      `)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      return v1ErrorResponseFromCode('SI_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const opCtx = { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log }
    const planned = await planSupplierSettlement(opCtx, invoice as unknown as SettleableSupplierInvoice, input)
    if (!planned.ok) return v1OutcomeResponse(planned, ctx)
    const { plan } = planned

    // The API states what the dashboard dialog defaults to: when the verifikat
    // clears 2440 at its booked SEK, any rate delta must reach 3960 / 7960 or
    // AP carries a stranded 2440 balance after the bank line clears. Gated on
    // the booking state, not the current setting.
    if (
      plan.invoice.currency !== 'SEK' &&
      !plan.useCashEntry &&
      input.exchangeRateDifference === undefined &&
      input.amountSek === undefined
    ) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: [{
            field: 'exchange_rate_difference',
            message:
              'exchange_rate_difference (cleared SEK minus paid SEK) or amount_sek (the SEK that left the payment account) is required when paying a non-SEK supplier invoice under faktureringsmetoden. Use exchange_rate_difference 0 if the payment cost exactly the SEK the invoice carries on 2440.',
          }],
          invoice_currency: plan.invoice.currency,
        },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          ...plan.invoice,
          status: plan.newStatus,
          paid_amount: plan.newPaidAmount,
          remaining_amount: plan.newRemaining,
          paid_at: plan.paidAt,
          payment_date: plan.paymentDate,
          payment_amount: plan.paymentAmount,
          // SEK the accrual clearing takes off 2440, and the kursdifferens
          // (> 0 gain on 3960, < 0 loss on 7960). Custom lines and the cash
          // entry carry their own SEK.
          ...(!input.lines && !plan.useCashEntry
            ? { payment_amount_sek: plan.clearingSek, exchange_rate_difference: plan.exchangeRateDifference ?? 0 }
            : {}),
          // The account the committed entry will credit, already resolved, so
          // a caller can verify the routing before committing.
          payment_account: plan.paymentAccount,
          would_create_payment_journal_entry: true,
          // The registration verifikat the commit books first, or null.
          would_book_registration_first: plan.registration.required,
          registration_journal_entry: plan.registration.required ? plan.registration.entry : null,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const settled = await bookSupplierSettlement(opCtx, plan, {
      user_id: ctx.userId,
      actor_id: ctx.apiKeyId ?? null,
      actor_type: ctx.actor.type,
      actor_label: ctx.actor.label ?? null,
    })
    if (!settled.ok) return v1OutcomeResponse(settled, ctx)

    // The response is the row as stored, never the pre-flight's items or supplier.
    const { data: stored, error: storedError } = await ctx.supabase
      .from('supplier_invoices')
      .select(SI_PAID_RESPONSE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()
    if (storedError) {
      ctx.log.warn('supplier-invoice mark-paid: the settled row could not be re-read', storedError, { invoiceId })
    }

    return ok(
      stored ?? {
        id: invoiceId,
        status: settled.newStatus,
        total: plan.invoice.total,
        paid_amount: settled.newPaidAmount,
        remaining_amount: settled.newRemaining,
        paid_at: settled.paidAt,
        payment_journal_entry_id: settled.journalEntryId,
        registration_journal_entry_id: settled.registrationJournalEntryId ?? plan.invoice.registration_journal_entry_id ?? null,
      },
      { requestId: ctx.requestId, ...(settled.warnings.length > 0 ? { warnings: settled.warnings } : {}) },
    )
  },
  { requireIdempotencyKey: true },
)
