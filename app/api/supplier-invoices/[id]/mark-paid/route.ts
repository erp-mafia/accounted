import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { validateBody } from '@/lib/api/validate'
import { MarkSupplierInvoicePaidSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
} from '@/lib/invoices/duplicate-payment-guard'
import {
  invoiceAmountSek,
  magnitudesWithinTolerance,
  normalizeCurrencyCode,
  planAmountSweeps,
  type ComparableAmount,
} from '@/lib/invoices/duplicate-guard-currency'
import { resolveTransactionAmountSek } from '@/lib/transactions/booking-duplicate-detection'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const POST = withRouteContext(
  'supplier_invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const validation = await validateBody(request, MarkSupplierInvoicePaidSchema, {
      log: opLog,
      operation: 'supplier_invoice.mark_paid',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: invoice, error: fetchError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !invoice) {
      return errorResponseFromCode('SI_NOT_FOUND', opLog, { requestId })
    }

    if (!['registered', 'approved', 'partially_paid', 'overdue'].includes(invoice.status)) {
      return errorResponseFromCode('SI_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const paymentDate = body.payment_date || new Date().toISOString().split('T')[0]
    const paymentAmount = body.amount || invoice.remaining_amount

    if (body.force) {
      opLog.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        paymentAmount,
        paymentDate,
      })
    }

    // Duplicate-payment guard: if a likely-matching unlinked bank transaction
    // exists for this supplier, surface it before booking a new payment entry.
    // Caller can override with `force: true`. Skipped on partial payments:
    // those are an explicit, deliberate action.
    const paidRounded = Math.round(paymentAmount * 100) / 100
    const remainingRounded = Math.round(invoice.remaining_amount * 100) / 100
    if (!body.force && paidRounded >= remainingRounded) {
      const supplierName = (invoice as SupplierInvoice & { supplier?: { name?: string } })
        .supplier?.name
      if (!supplierName) {
        // An invoice without a resolved supplier name is arguably *higher* risk
        // for duplicate booking, not lower (BFL 5 kap 7 §: motpart should be
        // identifiable). Log the skip so the gap is visible in audit.
        opLog.warn('duplicate-payment guard skipped', {
          reason: 'missing_supplier_name',
          supplierInvoiceId: id,
        })
      }
      if (supplierName) {
        // Units: `paymentAmount` is denominated in the supplier invoice's
        // currency (that is what `remaining_amount` and `body.amount` are),
        // while `transactions.amount` is denominated in the bank row's own
        // currency. The plus-minus tolerance band is therefore planned per
        // currency and re-checked per row, so band and column always share a
        // unit. A SEK invoice yields exactly one sweep with the band it had
        // before, so a SEK-only company sees the identical single query.
        const paymentCurrency = normalizeCurrencyCode(invoice.currency)
        const reference: ComparableAmount = {
          amount: paymentAmount,
          currency: paymentCurrency,
          sek: invoiceAmountSek({
            amount: paymentAmount,
            currency: paymentCurrency,
            total: invoice.total,
            totalSek: invoice.total_sek,
            exchangeRate: invoice.exchange_rate,
          }),
        }
        const { sweeps, crossCurrencyUnverifiable } = planAmountSweeps(
          reference,
          DUPLICATE_AMOUNT_TOLERANCE_PCT,
        )
        if (crossCurrencyUnverifiable) {
          // A foreign invoice with no stored rate cannot be stated in kronor,
          // so kronor bank rows can only be excluded, never compared raw
          // (a raw compare reads 1 000 EUR as 1 000 kr). Same-currency rows are
          // still swept. Logged so the blind spot is visible in audit rather
          // than passing as a clean "no duplicate".
          opLog.warn('duplicate-payment guard: cross-currency candidates not evaluated', {
            reason: 'invoice_missing_sek_value',
            currency: paymentCurrency,
            supplierInvoiceId: id,
          })
        }

        const dateMs = new Date(paymentDate).getTime()
        const dateLow = new Date(dateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000).toISOString().split('T')[0]
        const dateHigh = new Date(dateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000).toISOString().split('T')[0]
        const escapedSupplierName = escapeLikePattern(supplierName)

        type CandidateRow = {
          id: string
          date: string
          amount: number
          description: string | null
          merchant_name: string | null
          currency: string | null
          amount_sek: number | null
          exchange_rate: number | null
        }

        const sweepResults = await Promise.all(
          sweeps.map((sweep) =>
            supabase
              .from('transactions')
              .select(
                'id, date, amount, description, merchant_name, currency, amount_sek, exchange_rate',
              )
              .eq('company_id', companyId!)
              .eq('is_business', true)
              .is('supplier_invoice_id', null)
              .is('invoice_id', null)
              .lt('amount', 0)
              .or(sweep.currencyFilter)
              .gte('amount', -sweep.high)
              .lte('amount', -sweep.low)
              .gte('date', dateLow)
              .lte('date', dateHigh)
              .ilike('merchant_name', `%${escapedSupplierName}%`)
              .order('date', { ascending: false })
              .limit(5),
          ),
        )

        const byId = new Map<string, CandidateRow>()
        for (const res of sweepResults) {
          for (const row of (res.data ?? []) as CandidateRow[]) {
            if (!byId.has(row.id)) byId.set(row.id, row)
          }
        }
        const candidates = Array.from(byId.values())
          .filter((c) =>
            magnitudesWithinTolerance(
              reference,
              {
                amount: Number(c.amount),
                currency: normalizeCurrencyCode(c.currency),
                sek: resolveTransactionAmountSek({
                  amount: c.amount,
                  currency: c.currency,
                  amount_sek: c.amount_sek,
                  exchange_rate: c.exchange_rate,
                }),
              },
              DUPLICATE_AMOUNT_TOLERANCE_PCT,
            ),
          )
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .slice(0, 5)

        if (candidates.length > 0) {
          return errorResponseFromCode('SI_PAID_LIKELY_DUPLICATE', opLog, {
            requestId,
            details: {
              candidates: candidates.map((c) => ({
                id: c.id,
                date: c.date,
                amount: c.amount,
                description: c.description,
                merchant_name: c.merchant_name,
              })),
            },
          })
        }
      }
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, last_supplier_payment_account')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const paymentAccount = body.payment_account || undefined

    // Route on the supplier invoice's actual booking state, not the current
    // accounting_method. A supplier invoice that was booked at receipt under
    // accrual (Dr expense + 2641 / Cr 2440) must clear 2440 here even if the
    // company has since switched to kontantmetoden: otherwise the supplier
    // debt orphans on 2440 and expense + input VAT double-count.
    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    let journalEntryId: string | null = null

    try {
      if (body.lines) {
        const totalDebit = body.lines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = body.lines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return errorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', opLog, {
            requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, paymentDate)
        if (!fiscalPeriodId) {
          return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', opLog, {
            requestId,
            details: { paymentDate },
          })
        }
        const sourceType = useCashEntry ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid'
        const desc = invoice.supplier?.name
          ? `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}, ${invoice.supplier.name}`
          : `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}`
        const je = await createJournalEntry(supabase, companyId!, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: paymentDate,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          lines: body.lines,
        })
        if (je) journalEntryId = je.id
      } else if (useCashEntry) {
        const journalEntry = await createSupplierInvoiceCashEntry(
          supabase, companyId!, user.id,
          invoice as SupplierInvoice,
          (invoice.items || []) as SupplierInvoiceItem[],
          paymentDate,
          invoice.supplier?.supplier_type || 'swedish_business',
          invoice.supplier?.name,
          paymentAccount,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      } else {
        const journalEntry = await createSupplierInvoicePaymentEntry(
          supabase, companyId!, user.id,
          invoice as SupplierInvoice,
          paymentAmount, paymentDate,
          body.exchange_rate_difference,
          invoice.supplier?.name,
          paymentAccount,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      }
    } catch (err) {
      if (isBookkeepingError(err)) {
        return errorResponse(err, opLog, { requestId })
      }
      opLog.error('failed to create payment journal entry', err as Error)
      return errorResponseFromCode('SI_PAID_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }

    // Fail closed: every supplier payment must post a voucher. If a helper
    // returned null without throwing (e.g. a closed/locked fiscal period), do
    // NOT flip the invoice: that would diverge the GL from the AP sub-ledger.
    if (!journalEntryId) {
      opLog.error('supplier mark-paid produced no journal entry; refusing to mark paid', undefined)
      return errorResponseFromCode('SI_PAID_FAILED', opLog, {
        requestId,
        details: { reason: 'no_journal_entry_created' },
      })
    }

    const newRemaining = Math.round((invoice.remaining_amount - paymentAmount) * 100) / 100
    const newPaidAmount = Math.round((invoice.paid_amount + paymentAmount) * 100) / 100
    const isFullyPaid = newRemaining <= 0
    const newStatus = isFullyPaid ? 'paid' : 'partially_paid'
    const paidAt = isFullyPaid ? paidAtFromDate(paymentDate) : null

    const { data: updateResult, error: updateError } = await supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: Math.max(0, newRemaining),
        paid_amount: newPaidAmount,
        paid_at: paidAt,
        payment_journal_entry_id: journalEntryId,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
      .select('id')

    if (updateError) {
      opLog.error('supplier invoice update failed', updateError)
      // The payment voucher already posted but the invoice row did not flip;
      // cancel the orphan so the GL doesn't diverge from the AP sub-ledger.
      await cancelOrphanedPaymentEntry(
        supabase, companyId!, user.id, journalEntryId,
        'Automatiskt makulerad: fakturauppdatering misslyckades efter bokförd betalning',
      )
      return errorResponse(updateError, opLog, { requestId })
    }

    if (!updateResult || updateResult.length === 0) {
      // CAS guard: another request paid the invoice between our read and write.
      // Cancel the orphaned JE and document the voucher gap.
      await cancelOrphanedPaymentEntry(
        supabase, companyId!, user.id, journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
      return errorResponseFromCode('SI_PAID_ALREADY', opLog, {
        requestId,
        details: { reason: 'race' },
      })
    }

    // Record the payment row. payment-sync.ts derives the reversal/recalc amount
    // from this row (falling back to the FULL paid_amount when the row is
    // missing), so a missing row would silently desync a later reversal of a
    // PARTIAL payment. The status flip above already succeeded, so on insert
    // failure roll the invoice back to its pre-payment state and cancel the
    // voucher rather than leave it 'paid' with no payment record (the previous
    // code swallowed this error and left the sub-ledger desynced).
    const { error: paymentError } = await supabase
      .from('supplier_invoice_payments')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_invoice_id: id,
        payment_date: paymentDate,
        amount: paymentAmount,
        currency: invoice.currency,
        exchange_rate_difference: body.exchange_rate_difference || 0,
        journal_entry_id: journalEntryId,
        notes: body.notes || null,
      })

    if (paymentError) {
      opLog.error('failed to record supplier_invoice_payments row: rolling back', paymentError)
      await supabase
        .from('supplier_invoices')
        .update({
          status: invoice.status,
          remaining_amount: invoice.remaining_amount,
          paid_amount: invoice.paid_amount,
          paid_at: invoice.paid_at ?? null,
          payment_journal_entry_id:
            (invoice as { payment_journal_entry_id?: string | null }).payment_journal_entry_id ?? null,
        })
        .eq('id', id)
        .eq('company_id', companyId)
        // CAS: only undo OUR flip. If a concurrent request already transitioned
        // the row away from newStatus, don't clobber that legitimate state.
        .eq('status', newStatus)
      await cancelOrphanedPaymentEntry(
        supabase, companyId!, user.id, journalEntryId,
        'Automatiskt makulerad: betalningspost kunde inte registreras',
      )
      return errorResponseFromCode('SI_PAID_FAILED', opLog, {
        requestId,
        details: { reason: 'payment_record_insert_failed' },
      })
    }

    // Fully settled: retire every transaction's suggestion pointer at this
    // invoice (issue #1259). No exceptTransactionId: this flow is not driven by
    // a bank transaction, so any pointer at it is now dead.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(supabase, companyId!, 'supplier_invoice', id)
    }

    // Under kontantmetoden the cash payment entry is the ONLY booking of the
    // affärshändelse, so its underlag (the document from the inbox) must hang on
    // THIS verifikat per BFL 5 kap 6 §. Under faktureringsmetoden the document
    // is normally already linked to the registration verifikat at receipt, in
    // which case anchorSupplierInvoiceDocument is a no-op (it never moves an
    // anchored document). It only steps in when the document is floating, e.g.
    // attached after registration or orphaned by a deleted rättelse: without an
    // anchor every missing-underlag surface warns on a verifikat that plainly
    // shows the invoice. Non-fatal by construction: the payment is already
    // committed and immutable, so the helper logs and returns null on failure.
    await anchorSupplierInvoiceDocument(supabase, companyId!, id)

    try {
      await eventBus.emit({
        type: 'supplier_invoice.paid',
        payload: {
          supplierInvoice: { ...invoice, paid_at: paidAt ?? invoice.paid_at } as SupplierInvoice,
          paymentAmount,
          companyId: companyId!,
          userId: user.id,
        },
      })
    } catch (err) {
      opLog.warn('supplier_invoice.paid event emission failed', err as Error)
    }

    // Remember the chosen payment account so the next dialog can default to it.
    // Only update when the caller actually picked one: the MCP / agent path
    // sends no payment_account and shouldn't churn this setting.
    if (paymentAccount && paymentAccount !== settings?.last_supplier_payment_account) {
      const { error: settingsError } = await supabase
        .from('company_settings')
        .update({ last_supplier_payment_account: paymentAccount })
        .eq('company_id', companyId)
      if (settingsError) {
        opLog.warn('failed to persist last_supplier_payment_account', settingsError)
      }
    }

    return NextResponse.json({
      success: true,
      status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: Math.max(0, newRemaining),
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
