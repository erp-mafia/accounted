/**
 * POST /api/v1/companies/{companyId}/supplier-invoices/{id}/mark-paid
 *
 * Records a payment against a supplier invoice. Books the payment journal
 * entry via createSupplierInvoicePaymentEntry (accrual) or
 * createSupplierInvoiceCashEntry (cash basis — recognizes the expense here),
 * then flips status to `paid` or `partially_paid` with an optimistic-lock
 * UPDATE that prevents double-booking under concurrent calls.
 *
 * Strict-mode v1 (per Phase 3 lessons): if JE creation fails, the route
 * ABORTS before any SI state mutation — no payment row is written, status
 * is unchanged. The caller can retry cleanly.
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import {
  createSupplierInvoiceCashEntry,
  createSupplierInvoicePaymentEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { reverseEntry, createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

const SI_PAID_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, status, currency, total, paid_amount, remaining_amount, paid_at, payment_journal_entry_id'

const PAYABLE_STATUSES = ['registered', 'approved', 'partially_paid', 'overdue'] as const

const SupplierInvoicePaidResponse = z.object({
  id: z.string().uuid(),
  status: z.enum(['paid', 'partially_paid']),
  total: z.number(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  payment_journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'supplier-invoices.mark-paid',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id/mark-paid',
  summary: 'Record a payment against a supplier invoice.',
  description:
    'Books the payment journal entry (Debit 2440 / Credit 1930 under accrual; or Debit expense + Debit 2641 / Credit 1930 under cash) and flips the SI status to `paid` (full settlement) or `partially_paid`. Strict-mode: a JE failure aborts before any SI mutation. Idempotent. Dry-runnable.',
  useWhen:
    'You paid a registered or approved leverantörsfaktura through a channel other than the synced bank flow. For bank-matched payments use POST /transactions/{id}/match-supplier-invoice instead — that path also reconciles the bank line.',
  doNotUseFor:
    'Refunding a payment (the public API does not expose unmark-paid; credit the SI instead). Paying a credited or already-paid SI (returns 409 SI_PAID_ALREADY).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'payment_date must fall in an open fiscal period — locked period returns 400 PERIOD_LOCKED.',
    'exchange_rate_difference (SEK delta vs the booked rate at registration) is required for foreign-currency SIs to book the FX gain/loss to 3960 / 7960. Omitting it on a non-SEK SI under accrual mis-books FX.',
    'Strict-mode: a JE creation failure ABORTS before the status flip. There is no partial-state recovery banner — retry the call.',
    'Cash basis (kontantmetoden) recognizes the expense + ingående moms HERE, not at :create.',
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
  response: { success: SupplierInvoicePaidResponse },
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

    // Body is optional — empty POST = pay the full remaining_amount today.
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

    let bodyAmount: number | undefined
    let bodyPaymentDate: string | undefined
    let exchangeRateDifference: number | undefined
    let bodyNotes: string | undefined
    let customLines:
      | Array<{ account_number: string; debit_amount: number; credit_amount: number; line_description?: string }>
      | undefined
    if (rawBody) {
      const parsed = MarkSupplierInvoicePaidSchema.safeParse(rawBody)
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
      bodyAmount = parsed.data.amount
      bodyPaymentDate = parsed.data.payment_date
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyNotes = parsed.data.notes
      customLines = parsed.data.lines
    }

    const today = new Date().toISOString().split('T')[0]
    const paymentDate = bodyPaymentDate || today

    // Reject future payment_date at the schema layer. BFL 5 kap 2 §
    // requires bokföring to follow real cash movement; a payment booked
    // in the future is a scheduling artefact, not an affärshändelse.
    // No legitimate v1 workflow needs to backstamp tomorrow; if the user
    // wants to schedule, that's a different surface.
    if (paymentDate > today) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'payment_date',
          message: 'payment_date cannot be in the future.',
          attempted: paymentDate,
          today,
        },
      })
    }

    // Fetch SI with supplier + items (needed by the engine for cash-basis).
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('supplier_invoices')
      .select(`
        id, supplier_id, status, currency, exchange_rate, total, paid_amount, remaining_amount,
        supplier_invoice_number, arrival_number, invoice_date, vat_treatment, reverse_charge,
        subtotal, subtotal_sek, vat_amount, vat_amount_sek, total_sek, due_date, received_date,
        is_credit_note, credited_invoice_id, payment_journal_entry_id,
        supplier:suppliers(id, name, supplier_type),
        items:supplier_invoice_items(id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate)
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

    type SupplierObj = { id: string; name: string; supplier_type: string }
    type SI = {
      id: string
      supplier_id: string
      status: string
      currency: string
      total: number
      paid_amount: number
      remaining_amount: number
      supplier_invoice_number: string
      arrival_number: number
      invoice_date: string
      is_credit_note: boolean
      supplier: SupplierObj | SupplierObj[] | null
      items?: unknown[]
    } & Record<string, unknown>

    const typed = invoice as unknown as SI

    if (typed.is_credit_note) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Credit notes cannot be marked paid.' },
      })
    }

    if (!PAYABLE_STATUSES.includes(typed.status as (typeof PAYABLE_STATUSES)[number])) {
      const code = typed.status === 'paid' || typed.status === 'credited' || typed.status === 'reversed'
        ? 'SI_PAID_ALREADY'
        : 'SI_PAID_NOT_PAYABLE'
      return v1ErrorResponseFromCode(code, ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: typed.status },
      })
    }

    // Application-layer period-lock pre-check.
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, paymentDate)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('SI_PAID_PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
          payment_date: paymentDate,
        },
      })
    }

    const paymentAmount = bodyAmount != null
      ? Math.round(bodyAmount * 100) / 100
      : Math.round(typed.remaining_amount * 100) / 100

    if (paymentAmount <= 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'amount', message: 'amount must be positive.' },
      })
    }

    // Reject overpayment up front. Without this, the silent `Math.max(0, ...)`
    // clamp below would book the full payment_amount in the JE but only
    // reduce the SI balance to 0 — the difference would be an unaccounted
    // overpayment on the 2440 ledger. If a refund is genuinely due, the
    // caller credits the SI (which reverses the obligation) and books the
    // refund as a separate bank transaction. Half-öre tolerance allows
    // legitimate rounding artefacts from FX-difference adjustments.
    if (paymentAmount > typed.remaining_amount + 0.005) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'amount',
          message:
            'amount exceeds remaining_amount. Issue a credit note via :credit for over-billing, or book the refund through the transactions endpoints.',
          attempted: paymentAmount,
          remaining_amount: typed.remaining_amount,
        },
      })
    }

    const newRemaining = Math.max(
      0,
      Math.round((typed.remaining_amount - paymentAmount) * 100) / 100,
    )
    // Half-öre epsilon — same convention as v1 invoices.mark-paid.
    const newStatus: 'paid' | 'partially_paid' = newRemaining <= 0.005 ? 'paid' : 'partially_paid'
    const newPaidAmount = Math.round((typed.paid_amount + paymentAmount) * 100) / 100

    // Settings fetch hoisted ahead of the dry-run branch so the FX-required
    // check below fires in both preview and commit modes (and so dry-run can
    // surface the requirement before a caller learns it the hard way).
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod = (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'

    // Route on the supplier invoice's actual booking state — if 2440 was
    // posted at receipt, payment must clear 2440 regardless of the current
    // accounting_method.
    const siAlreadyBooked = !!(typed as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // FX-required validation. Whenever the registration JE used the invoice's
    // exchange rate to compute subtotal_sek (i.e. the SI was booked under
    // accrual or migrated from accrual), the payment JE has to book any rate
    // delta to 3960 / 7960 or AP will carry a stranded 2440 balance after the
    // bank line clears. Gated on the booking state, not the current setting.
    if (
      typed.currency !== 'SEK' &&
      !useCashEntry &&
      exchangeRateDifference === undefined
    ) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: [{
            field: 'exchange_rate_difference',
            message:
              'exchange_rate_difference (SEK delta vs the registration rate) is required when paying a non-SEK supplier invoice under faktureringsmetoden. Use 0 if there is no rate movement.',
          }],
          invoice_currency: typed.currency,
        },
      })
    }

    if (ctx.dryRun) {
      // paid_at: the live UPDATE writes `new Date().toISOString()` (a full UTC
      // timestamp). Mirror that shape here so callers validating dry-run vs
      // live against the same regex don't see surprises. payment_date stays
      // ISO date because it represents the user-supplied calendar date.
      return dryRunPreview(
        {
          ...typed,
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
          payment_date: paymentDate,
          payment_amount: paymentAmount,
          would_create_payment_journal_entry: true,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const pickSupplier = (s: SI['supplier']): SupplierObj | null => {
      if (!s) return null
      return Array.isArray(s) ? (s[0] ?? null) : s
    }
    const supplierRow = pickSupplier(typed.supplier)

    // Strict-mode: book the JE FIRST. Failure aborts before any SI mutation.
    let journalEntryId: string | null = null
    try {
      if (customLines) {
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return v1ErrorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', ctx.log, {
            requestId: ctx.requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId!, paymentDate)
        if (!fiscalPeriodId) {
          return v1ErrorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', ctx.log, {
            requestId: ctx.requestId,
            details: { payment_date: paymentDate },
          })
        }
        const sourceType = useCashEntry ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid'
        const desc = supplierRow?.name
          ? `Utbetalning leverantörsfaktura ${typed.supplier_invoice_number}, ${supplierRow.name}`
          : `Utbetalning leverantörsfaktura ${typed.supplier_invoice_number}`
        const entry = await createJournalEntry(ctx.supabase, ctx.companyId!, ctx.userId, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: paymentDate,
          description: desc,
          source_type: sourceType,
          source_id: typed.id,
          lines: customLines,
        })
        journalEntryId = entry?.id ?? null
      } else if (useCashEntry) {
        const entry = await createSupplierInvoiceCashEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          typed as unknown as SupplierInvoice,
          (typed.items ?? []) as SupplierInvoiceItem[],
          paymentDate,
          supplierRow?.supplier_type ?? 'swedish_business',
          supplierRow?.name,
        )
        journalEntryId = entry?.id ?? null
      } else {
        const entry = await createSupplierInvoicePaymentEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          typed as unknown as SupplierInvoice,
          paymentAmount,
          paymentDate,
          exchangeRateDifference,
          supplierRow?.name,
        )
        journalEntryId = entry?.id ?? null
      }
      if (!journalEntryId) {
        // Engine returned null (no open fiscal period). Strict-mode abort.
        return v1ErrorResponseFromCode('SI_PAID_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: 'no_fiscal_period', payment_date: paymentDate },
        })
      }
    } catch (err) {
      if (isBookkeepingError(err)) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
      ctx.log.error('supplier-invoice mark-paid JE creation failed', err as Error, {
        invoiceId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('SI_PAID_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }

    // Step 2: optimistic-lock SI update. The .in() filter guards against
    // concurrent calls (or a credit/mark-paid race) flipping the status
    // between our pre-flight and write.
    const { data: updated, error: updateErr } = await ctx.supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
        paid_amount: newPaidAmount,
        paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
        payment_journal_entry_id: journalEntryId,
      })
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .in('status', PAYABLE_STATUSES as unknown as string[])
      .select(SI_PAID_RESPONSE_COLUMNS)
      .maybeSingle()

    if (updateErr) {
      ctx.log.error('supplier-invoice mark-paid update failed — attempting storno of orphaned JE', updateErr, {
        invoiceId,
        companyId: ctx.companyId,
        userId: ctx.userId,
        journalEntryId,
      })
      // The payment JE is already posted but the SI update failed — without a
      // storno, the AP ledger would carry a 2440/1930 entry with no matching
      // SI status change (BFL 5 kap 5 § integrity violation). reverseEntry()
      // takes the entry id directly (no pre-fetch needed), matching the CAS-
      // race branch immediately below.
      try {
        await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, journalEntryId, paymentDate)
      } catch (revErr) {
        ctx.log.error('orphan JE storno failed after SI update error — manual reconciliation required', revErr as Error, {
          invoiceId,
          companyId: ctx.companyId,
          userId: ctx.userId,
          journalEntryId,
        })
      }
      return v1ErrorResponseFromCode('SI_PAID_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'si_update_failed', journal_entry_id: journalEntryId },
      })
    }
    if (!updated) {
      // CAS race: the SI moved out of a payable state between pre-flight and
      // write. The JE we just posted is now orphaned. Storno it.
      ctx.log.warn('supplier-invoice mark-paid race — JE was orphaned, attempting storno', {
        invoiceId,
        companyId: ctx.companyId,
        userId: ctx.userId,
        journalEntryId,
      })
      try {
        await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, journalEntryId, paymentDate)
      } catch (revErr) {
        ctx.log.error('orphan JE storno failed — manual reconciliation required', revErr as Error, {
          invoiceId,
          companyId: ctx.companyId,
          userId: ctx.userId,
          journalEntryId,
        })
      }
      return v1ErrorResponseFromCode('SI_PAID_ALREADY', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    // Step 3: record the payment row (non-blocking — its only consumer is the
    // dashboard's "payment history" tab, and the JE is the source of truth).
    const { error: paymentErr } = await ctx.supabase
      .from('supplier_invoice_payments')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        supplier_invoice_id: invoiceId,
        payment_date: paymentDate,
        amount: paymentAmount,
        currency: typed.currency,
        exchange_rate_difference: exchangeRateDifference ?? 0,
        journal_entry_id: journalEntryId,
        notes: bodyNotes ?? null,
      })
    if (paymentErr) {
      ctx.log.warn('supplier_invoice_payments insert failed (non-blocking)', paymentErr, {
        invoiceId,
      })
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.paid',
        payload: {
          supplierInvoice: typed as unknown as SupplierInvoice,
          paymentAmount,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.warn('supplier_invoice.paid emit failed', err as Error)
    }

    return ok(updated, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
