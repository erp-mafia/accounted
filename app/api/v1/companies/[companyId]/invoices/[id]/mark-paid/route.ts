/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/mark-paid
 *
 * Manually marks an invoice as paid: for payments received outside the
 * bank-sync flow.
 *
 * Accounting:
 *   - Faktureringsmetoden (accrual): Debit 1930 / Credit 1510. The invoice
 *     was already booked as revenue at :mark-sent; this just settles the AR.
 *   - Kontantmetoden (cash): Debit 1930 / Credit 30xx + Credit 26xx. Revenue
 *     recognition happens here (no entry at :mark-sent under cash basis).
 *
 * Optional request body (all fields optional: empty POST = book full payment
 * on today's date with default lines):
 *   - payment_date              ISO date; defaults to today
 *   - exchange_rate_difference  SEK adjustment for foreign-currency invoices
 *   - lines                     Custom balanced journal lines (partial payments)
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *
 * On commit:
 *   1. Build journal entry (default 1930/1510 split, or custom lines).
 *   2. Post via createInvoicePaymentJournalEntry / createJournalEntry.
 *   3. Update invoice: status → 'paid' (or 'partially_paid' for partial),
 *      remaining_amount decremented, paid_at set, paid_amount accumulated.
 *   4. Emit invoice.paid.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import {
  createInvoiceCashEntry,
  createInvoicePaymentJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { eventBus } from '@/lib/events'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryInput, EntityType, Invoice } from '@/types'

// default_dimensions must stay in this projection: the fetched row feeds the
// payment/cash JE generators, which re-propagate the bag onto every leg —
// dropping the column here silently untags the payment voucher.
const INVOICE_MARK_PAID_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, paid_at, paid_amount, remaining_amount, default_dimensions, created_at, updated_at'

const InvoiceMarkPaidResponse = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  status: z.enum(['paid', 'partially_paid']),
  total: z.number(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  journal_entry_id: z.string().uuid().nullable(),
  warnings: z
    .array(z.object({ code: z.string(), message: z.string() }))
    .optional(),
})

registerEndpoint({
  operation: 'invoices.mark-paid',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/mark-paid',
  summary: 'Record a payment against an invoice.',
  description:
    'Marks a sent / overdue invoice as paid (or partially_paid). Books the payment via Debit 1930 / Credit 1510 under faktureringsmetoden, or Debit 1930 / Credit revenue + Credit output VAT under kontantmetoden. Optional body supports partial payments via custom balanced journal lines and exchange-rate adjustments for foreign-currency invoices. Idempotent and dry-runnable. Emits invoice.paid.',
  useWhen:
    'A customer paid an invoice via a channel other than the synced bank account (cash, manual transfer, separate processor). Use dry-run to confirm the booking before committing.',
  doNotUseFor:
    'Reverting a payment: the public API does not expose unmark-paid. Issue a credit note via POST /:id/credit to cancel the underlying invoice instead. Bank-matched payments: those flow through the transactions endpoints.',
  pitfalls: [
    'Idempotency-Key is mandatory. Retried marks with the same key replay the cached response.',
    'Custom `lines` must balance (sum of debits = sum of credits, both > 0). Otherwise returns 400 INVOICE_PAID_LINES_UNBALANCED.',
    'For foreign-currency invoices, supply `exchange_rate_difference` (SEK delta vs the invoice\'s booked rate) to book the FX adjustment correctly. Omitting it on a non-SEK invoice will mis-book the FX gain/loss.',
    'Cash basis (kontantmetoden) recognizes revenue HERE, not at :mark-sent. The dashboard tracks this via company_settings.accounting_method.',
    'Duplicate-payment guard: if an unlinked inbound bank transaction looks like this payment, returns 409 INVOICE_PAID_LIKELY_DUPLICATE with candidate transactions. Retry with `force: true` to bypass, but the retry MUST use a fresh Idempotency-Key (the original is body-hash bound; reusing it returns 400 IDEMPOTENCY_KEY_REUSE). The guard is also evaluated under dry-run, so a successful dry-run does not guarantee a successful commit.',
  ],
  example: {
    request: { payment_date: '2026-05-12' },
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        status: 'paid',
        total: 12500,
        paid_amount: 12500,
        remaining_amount: 0,
        paid_at: '2026-05-12',
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
  request: { body: MarkInvoicePaidSchema },
  response: { success: dataEnvelope(InvoiceMarkPaidResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.mark-paid',
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

    // Body is optional. Empty POST → book full payment today.
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

    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines:
      | {
          account_number: string
          debit_amount: number
          credit_amount: number
          line_description?: string
        }[]
      | undefined
    let force = false
    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            issues: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          },
        })
      }
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
      force = parsed.data.force === true
    }

    // Pre-flight: fetch invoice with relations needed for journal entry.
    // journal_entry_id is fetched for booking-state routing only (it stays out
    // of INVOICE_MARK_PAID_RESPONSE_COLUMNS so the response contract and the
    // invoice.paid event payload are unchanged).
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(
        `${INVOICE_MARK_PAID_RESPONSE_COLUMNS}, journal_entry_id, customer:customers(id, name, customer_type), items:invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, dimensions)`,
      )
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      ctx.log.warn('invoices.mark-paid: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('INVOICE_PAID_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const typed = invoice as unknown as Invoice & { customer?: { name?: string } }

    // Document-shape guards before status check (consistent with mark-sent).
    if (typed.document_type === 'delivery_note') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'document_type',
          message: 'Delivery notes do not have payment lifecycle.',
        },
      })
    }
    if (typed.credited_invoice_id) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'credited_invoice_id',
          message: 'Credit notes cannot be marked paid; the original invoice they credit was already accounted for.',
        },
      })
    }

    if (typed.status !== 'sent' && typed.status !== 'overdue') {
      return v1ErrorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Validate custom lines balance (if supplied).
    if (customLines) {
      const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
      const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
      if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
        return v1ErrorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', ctx.log, {
          requestId: ctx.requestId,
          details: { total_debit: totalDebit, total_credit: totalCredit },
        })
      }
    }

    const today = new Date().toISOString().split('T')[0]
    const paymentDate = bodyPaymentDate || today

    // Fetch settings for accounting method + entity type.
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod =
      (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'
    const entityType = ((settings as { entity_type?: string } | null)?.entity_type ??
      'enskild_firma') as EntityType

    // The JE shape is driven by the invoice's actual booking state, not the
    // company's current accounting_method. An invoice that was booked at send
    // under accrual (Dr 1510) must be cleared at payment regardless of where
    // the setting sits today: otherwise the receivable orphans and 30xx +
    // VAT double-count. Only true kontantmetoden invoices (never booked)
    // recognise revenue + VAT here.
    const invoiceAlreadyBooked = !!(typed as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash'

    // Compute the would-be payment amount. Default path (no customLines):
    // use remaining_amount, not total: protects against over-crediting AR
    // when a concurrent partial payment slips through the pre-flight check
    // (pre-flight sees status='sent' but the race-guard UPDATE later sees
    // status='partially_paid' so a second full-total amount would be booked
    // against an already-reduced AR balance). For legacy rows where
    // remaining_amount was never written, derive it from total − paid_amount
    // rather than the full total. This is the booking-currency amount (SEK for
    // custom lines) used by the duplicate guard, the JE builder, and the event.
    const paymentAmount = customLines
      ? customLines.reduce((s, l) => s + l.debit_amount, 0)
      : (typed.remaining_amount ?? typed.total - (typed.paid_amount ?? 0))

    // Ledger math + overpayment guard via the shared planInvoicePayment helper:
    // the single source of truth across all three mark-paid surfaces (this route,
    // the dashboard route, and the agent commit path), so the paid/remaining/
    // status math can never drift again. Custom lines are SEK; convert to invoice
    // currency for the comparison so a foreign-currency invoice isn't falsely
    // rejected as overpaid (the default path is already in invoice currency).
    const fxRate =
      typed.currency && typed.currency !== 'SEK' && typed.exchange_rate
        ? typed.exchange_rate
        : 1
    const paymentAmountInInvoiceCurrency = customLines
      ? roundOre(paymentAmount / fxRate)
      : paymentAmount
    const payment = planInvoicePayment(typed, paymentAmountInInvoiceCurrency)
    if (!payment.ok) {
      return v1ErrorResponseFromCode('MATCH_AMOUNT_EXCEEDS_REMAINING', ctx.log, {
        requestId: ctx.requestId,
        details: payment.details,
      })
    }
    const { newPaidAmount, newRemaining, newStatus, isFullyPaid } = payment.plan
    const isPartial = customLines !== undefined && !isFullyPaid

    // Duplicate-payment guard: surface a likely-matching unlinked inbound
    // bank transaction before booking (or before dry-run preview, so a
    // successful dry-run can't mask the warning). Skipped on partial
    // payments (paymentAmount < remaining is an explicit, deliberate action),
    // on force=true, and on invoices without a resolved customer name.
    const remainingForGuard = typed.remaining_amount ?? typed.total
    const paidRoundedGuard = Math.round(paymentAmount * 100) / 100
    const remainingRoundedGuard = Math.round(remainingForGuard * 100) / 100
    if (!force && paidRoundedGuard >= remainingRoundedGuard) {
      const customerName = typed.customer?.name
      if (!customerName) {
        ctx.log.warn('duplicate-payment guard skipped', {
          reason: 'missing_customer_name',
          invoiceId,
        })
      } else {
        const candidates = await findDuplicatePaymentCandidatesForInvoice(ctx.supabase, {
          companyId: ctx.companyId!,
          invoice: { invoice_number: typed.invoice_number, customer_name: customerName },
          paymentAmount,
          paymentDate,
        })
        if (candidates.length > 0) {
          return v1ErrorResponseFromCode('INVOICE_PAID_LIKELY_DUPLICATE', ctx.log, {
            requestId: ctx.requestId,
            details: { candidates },
          })
        }
      }
    } else if (force) {
      ctx.log.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        invoiceId,
        userId: ctx.userId,
        paymentAmount,
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          ...typed,
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: paymentDate,
          would_create_journal_entry: !typed.document_type || typed.document_type === 'invoice',
          accounting_method: accountingMethod,
          would_use_custom_lines: customLines !== undefined,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const warnings: { code: string; message: string }[] = []

    // Commit path. Step 1: book the journal entry. Three flavors:
    //   - Custom lines (partial payment etc.) → createJournalEntry directly
    //   - Cash basis → createInvoiceCashEntry (recognizes revenue here)
    //   - Accrual basis → createInvoicePaymentJournalEntry (settles AR)
    let journalEntryId: string | null = null
    const isRealInvoice = !typed.document_type || typed.document_type === 'invoice'
    if (isRealInvoice) {
      try {
        if (customLines) {
          const fiscalPeriodId = await findFiscalPeriod(
            ctx.supabase,
            ctx.companyId!,
            paymentDate,
          )
          if (!fiscalPeriodId) {
            return v1ErrorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', ctx.log, {
              requestId: ctx.requestId,
              details: { payment_date: paymentDate },
            })
          }
          const input: CreateJournalEntryInput = {
            fiscal_period_id: fiscalPeriodId,
            entry_date: paymentDate,
            description: `Delbetalning faktura ${typed.invoice_number ?? typed.id}`,
            source_type: 'invoice_paid',
            source_id: invoiceId,
            lines: customLines.map((l) => ({
              account_number: l.account_number,
              debit_amount: l.debit_amount,
              credit_amount: l.credit_amount,
              line_description: l.line_description ?? undefined,
            })),
          }
          const entry = await createJournalEntry(
            ctx.supabase,
            ctx.companyId!,
            ctx.userId,
            input,
          )
          journalEntryId = entry?.id ?? null
        } else if (useCashEntry) {
          const entry = await createInvoiceCashEntry(
            ctx.supabase,
            ctx.companyId!,
            ctx.userId,
            typed as Invoice,
            paymentDate,
            entityType,
            typed.customer?.name,
          )
          journalEntryId = entry?.id ?? null
        } else {
          const entry = await createInvoicePaymentJournalEntry(
            ctx.supabase,
            ctx.companyId!,
            ctx.userId,
            typed as Invoice,
            paymentDate,
            exchangeRateDifference,
            typed.customer?.name,
            // Pass full or partial amount depending on path.
            customLines ? paymentAmount : undefined,
          )
          journalEntryId = entry?.id ?? null
        }

        if (!journalEntryId) {
          // Fail closed: a real invoice must produce a posted payment voucher.
          // A null here (e.g. no open fiscal period) means nothing was booked,
          // so flipping the invoice to paid/partially_paid would diverge the GL
          // from the AR sub-ledger. Abort BEFORE the invoice update below:
          // mirrors the v1 match-invoice strict mode.
          ctx.log.error('mark-paid: no payment journal entry produced: aborting before state mutation', undefined, {
            invoiceId,
            companyId: ctx.companyId,
          })
          return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', ctx.log, {
            requestId: ctx.requestId,
            details: { reason: 'no_journal_entry_created' },
          })
        }
      } catch (err) {
        if (err instanceof AccountsNotInChartError) {
          return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
        }
        ctx.log.error('mark-paid: payment JE creation failed: aborting before state mutation', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        const message = isBookkeepingError(err)
          ? getErrorMessage(err, { context: 'invoice' })
          : err instanceof Error
            ? err.message
            : 'Unknown error'
        return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: message },
        })
      }
    }

    // Step 2: update the invoice row.
    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      remaining_amount: newRemaining,
      paid_amount: newPaidAmount,
      updated_at: new Date().toISOString(),
    }
    if (newStatus === 'paid') {
      updatePayload.paid_at = paymentDate
    }
    // Deliberately NOT writing journal_entry_id here: that column means "the
    // registration entry that booked this invoice at issuance" and drives the
    // invoiceAlreadyBooked routing above. Writing the payment/cash entry id
    // would make a kontantmetoden invoice look registered, so a later partial
    // payment would clear a 1510 that was never debited. The payment entry id
    // is returned in the response body instead.

    const { data: updated, error: updateErr } = await ctx.supabase
      .from('invoices')
      .update(updatePayload)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      // Race guard: only flip from a payable status.
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .select(INVOICE_MARK_PAID_RESPONSE_COLUMNS)
      .maybeSingle()

    if (updateErr) {
      ctx.log.error('mark-paid: invoice update failed', updateErr as Error, {
        invoiceId,
        companyId: ctx.companyId,
        pgCode: (updateErr as { code?: string }).code,
      })
      return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }
    if (!updated) {
      // Race: status transitioned (concurrent mark-paid / credit) between
      // pre-flight and our update. Surface as 409.
      ctx.log.warn('mark-paid: race: invoice status transitioned during request', {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_PAID_RACE', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Step 3: emit invoice.paid (best-effort, surfaces in warnings on fail).
    try {
      await eventBus.emit({
        type: 'invoice.paid',
        payload: {
          invoice: updated as unknown as Invoice,
          companyId: ctx.companyId!,
          userId: ctx.userId,
          paymentAmount,
          paymentDate,
        },
      })
    } catch (err) {
      ctx.log.error('invoice.paid emit failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      warnings.push({
        code: 'EVENT_EMIT_FAILED',
        message: 'invoice.paid event did not reach the bus; downstream subscribers may miss this transition.',
      })
    }

    ctx.log.info('invoices.mark-paid success', {
      invoiceId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      newStatus,
      journalEntryId,
      paymentAmount,
      isPartial,
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
