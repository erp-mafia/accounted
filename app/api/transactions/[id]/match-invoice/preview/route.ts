/**
 * GET /api/transactions/[id]/match-invoice/preview?invoice_id=...
 *
 * Returns the journal entry lines that match-invoice would create for this
 * (transaction, invoice) pair. Read-only: does not stage or write anything.
 *
 * The shape mirrors the routing decision in the POST handler: if the invoice
 * was already booked (invoice.journal_entry_id is set, i.e. 1510 is on the
 * books), we preview the clearing entry (Dr <resolved account> / Cr 1510).
 * Only when the invoice was never booked AND the company is on kontantmetoden
 * AND the receipt fully pays the invoice do we preview the cash entry
 * (Dr <resolved account> / Cr 30xx / Cr 26xx).
 *
 * The bank leg is resolved from THIS transaction's own cash_account_id via
 * resolveSettlementAccount, never hardcoded to 1930, so the preview stays
 * byte-identical to what the POST handler commits (mirrors the fix already
 * applied on the supplier-invoice side).
 *
 * The UI uses this to show the user the exact lines before they confirm:
 * the lack of any preview was part of the reported bug.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { roundOre, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { getRevenueAccount, getOutputVatAccount } from '@/lib/bookkeeping/invoice-entries'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import type { Currency, EntityType, Invoice, InvoiceItem } from '@/types'
import { z } from 'zod'

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

const QuerySchema = z.object({
  invoice_id: z.string().uuid(),
})

export const GET = withRouteContext(
  'transaction.match_invoice_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({ invoice_id: url.searchParams.get('invoice_id') })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'invoice_id', message: 'invoice_id must be a UUID' },
      })
    }
    const { invoice_id } = parsed.data

    // Data minimization (GDPR Art.5(1)(c)): amount_sek + exchange_rate are
    // pulled because buildInvoicePaymentClearingLines needs them for the
    // cross-currency bank-leg math (round-7 FX fix). cash_account_id resolves
    // which BAS account this bank line actually settles into, mirroring the
    // POST handler's settlement-account lookup. All other columns would
    // broaden the projection without serving the preview's purpose.
    const { data: transaction, error: txErr } = await supabase
      .from('transactions')
      .select('id, date, amount, amount_sek, currency, exchange_rate, cash_account_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()
    if (txErr || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('*, items:invoice_items(*)')
      .eq('id', invoice_id)
      .eq('company_id', companyId)
      .single()
    if (invErr || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', log, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    // Same resolution as the POST handler: debit the cash account this
    // transaction is actually linked to, never a hardcoded 1930, so the
    // preview stays byte-identical to what gets committed.
    const paymentAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      log,
    )

    // Cross-currency FX preview. When tx.currency !== invoice.currency we fetch
    // the Riksbanken spot rate for invoice.currency on the tx date and surface
    // the conversion to the dialog (the user sees the rate + invoice-currency-
    // equivalent before approving). The committed verifikat uses the same
    // numbers; the route POST handler re-runs the lookup so the rate at
    // commit time is authoritative.
    //
    // This MUST run BEFORE the paid / remaining / fully-paid math below.
    // invoice.remaining_amount and invoice.total are denominated in INVOICE
    // currency, so a SEK bank tx has to be converted first. Computing the
    // comparison from the raw SEK amount made a 1 000 SEK payment look like
    // it fully cleared a 140 USD invoice (newRemaining went negative →
    // isFullyPaid=true), which for a cash-method unbooked invoice previewed a
    // cash entry (Dr 1930 / Cr 30xx) that the POST: which converts first:
    // would never commit (it posts the clearing entry Dr 1930 / Cr 1510).
    //
    // Per ML 8 kap 21-23§ the rate effective on the payment date is the
    // correct conversion. If the lookup fails (Riksbanken outage, missing
    // rate for that date), the response carries `fx_conversion.error` and
    // the dialog can surface a manual-rate input field instead.
    type FxConversion =
      | {
          required: true
          tx_currency: string
          invoice_currency: string
          rate: number
          rate_date: string
          paid_in_invoice_currency: number
        }
      | { required: true; error: 'rate_unavailable'; tx_currency: string; invoice_currency: string }
      | { required: false }

    let fxConversion: FxConversion = { required: false }
    if (transaction.currency !== invoice.currency) {
      const rateInfo = await fetchExchangeRate(
        invoice.currency as Currency,
        new Date(transaction.date),
      )
      if (rateInfo && rateInfo.rate > 0) {
        // bankSek / rate = how many units of invoice.currency this payment
        // satisfies. Round to 4 decimal places to preserve precision through
        // subsequent partial-payment accumulations.
        const txAbsSek =
          transaction.currency === 'SEK'
            ? Math.abs(transaction.amount)
            : Math.abs(transaction.amount) * (transaction.exchange_rate ?? 1)
        const paidInInvoiceCurrency =
          Math.round((txAbsSek / rateInfo.rate) * 10000) / 10000
        fxConversion = {
          required: true,
          tx_currency: transaction.currency,
          invoice_currency: invoice.currency,
          rate: rateInfo.rate,
          rate_date: rateInfo.date,
          paid_in_invoice_currency: paidInInvoiceCurrency,
        }
      } else {
        fxConversion = {
          required: true,
          error: 'rate_unavailable',
          tx_currency: transaction.currency,
          invoice_currency: invoice.currency,
        }
      }
    }

    // paidAmount is denominated in INVOICE currency so the remaining /
    // fully-paid comparison is like-with-like. Same-currency → tx.amount.
    // Cross-currency with a resolved rate → the spot-rate conversion (mirrors
    // the POST handler's paidAmountInInvoiceCurrency).
    const paidAmount =
      fxConversion.required && !('error' in fxConversion)
        ? fxConversion.paid_in_invoice_currency
        : transaction.amount
    const currentRemaining =
      invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0)
    const newRemaining = Math.max(
      0,
      Math.round((currentRemaining - paidAmount) * 100) / 100,
    )
    // A rate-unavailable cross-currency payment can't be resolved to invoice
    // currency yet, so never report fully-paid (or preview the cash shape) on
    // a guess: the dialog blocks confirm until a manual rate is entered and
    // the POST recomputes the real figure.
    const fxRateUnavailable = fxConversion.required && 'error' in fxConversion
    // Pure-SEK whole-krona settlements absorb a sub-krona remainder as
    // öresavrundning (3740) and settle in full: mirror that here so the
    // preview's fully-paid signal matches the committed verifikat.
    const pureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'
    const isFullyPaid =
      !fxRateUnavailable &&
      (newRemaining <= 0 || (pureSek && newRemaining < ORE_ROUNDING_SETTLEMENT_MAX))

    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'

    if (useCashEntry) {
      entryType = 'cash'
      // Mirror createInvoiceCashEntry: per-rate revenue + VAT credits, 1930 debit.
      const inv = invoice as Invoice & { items?: InvoiceItem[] }
      const items = inv.items ?? []
      const isForeign = inv.currency !== 'SEK'

      // Per-item rate aggregation (matches generatePerRateLines semantics).
      // InvoiceItem.line_total is the NET line amount (EXCLUDES VAT): it sums
      // to invoice.subtotal, and each line's vat_amount = line_total * rate. The
      // commit path (generatePerRateLines) credits revenue with line_total
      // directly; subtracting vat here double-subtracts VAT and unbalances the
      // previewed verifikat against the 1930 debit (inv.total).
      const byRate = new Map<number, { subtotal: number; vat: number }>()
      if (items.length > 0) {
        for (const it of items) {
          const rate = it.vat_rate ?? 25
          const itemVat = resolveSekAmount(it.vat_amount, null, inv.currency, inv.exchange_rate)
          const itemTotal = resolveSekAmount(it.line_total, null, inv.currency, inv.exchange_rate)
          const sub = roundOre(itemTotal)
          const bucket = byRate.get(rate) ?? { subtotal: 0, vat: 0 }
          bucket.subtotal += sub
          bucket.vat += itemVat
          byRate.set(rate, bucket)
        }
      } else {
        // Fallback to invoice-level totals
        const sub = resolveSekAmount(inv.subtotal, inv.subtotal_sek, inv.currency, inv.exchange_rate)
        const vat = resolveSekAmount(inv.vat_amount, inv.vat_amount_sek, inv.currency, inv.exchange_rate)
        byRate.set(inv.vat_rate ?? 25, { subtotal: sub, vat })
      }

      const creditLines: PreviewLine[] = []
      for (const [rate, totals] of byRate) {
        const vatTreatment = totals.vat > 0
          ? (rate === 25 ? 'standard_25' : rate === 12 ? 'reduced_12' : rate === 6 ? 'reduced_6' : inv.vat_treatment)
          : inv.vat_treatment
        const revenueAcct = getRevenueAccount(vatTreatment, entityType)
        creditLines.push({
          account_number: revenueAcct,
          debit_amount: 0,
          credit_amount: Math.round(totals.subtotal * 100) / 100,
          description: `Försäljning ${rate}%`,
        })
        if (totals.vat > 0) {
          creditLines.push({
            account_number: getOutputVatAccount(vatTreatment),
            debit_amount: 0,
            credit_amount: Math.round(totals.vat * 100) / 100,
            description: `Utgående moms ${rate}%`,
          })
        }
      }

      const totalCredits = creditLines.reduce((s, l) => s + l.credit_amount, 0)
      const cashDebit = isForeign
        ? Math.round(totalCredits * 100) / 100
        : resolveSekAmount(inv.total, inv.total_sek, inv.currency, inv.exchange_rate)

      lines.push({
        account_number: paymentAccount,
        debit_amount: Math.round(cashDebit * 100) / 100,
        credit_amount: 0,
        description: 'Inbetalning från bank',
      })
      lines.push(...creditLines)
    } else {
      // Clearing entry. Delegates to the shared helper so the preview and
      // the committed verifikat are byte-identical: fixing the prior
      // bug where the preview ran `resolveSekAmount(tx.amount, null,
      // INV.currency, INV.rate)`, treating the SEK tx number as if it
      // were in the invoice's currency and multiplying by the invoice's
      // rate. That produced a fictitious bank-leg and silently dropped
      // the FX gain/loss for cross-currency invoices.
      const inv = invoice as Invoice
      const { lines: clearingLines } = buildInvoicePaymentClearingLines(
        {
          amount: transaction.amount,
          amount_sek: transaction.amount_sek ?? null,
          currency: transaction.currency,
          exchange_rate: transaction.exchange_rate ?? null,
        },
        {
          currency: inv.currency,
          exchange_rate: inv.exchange_rate ?? null,
          remaining_amount: inv.remaining_amount ?? null,
          total: inv.total,
          paid_amount: inv.paid_amount ?? null,
        },
        'Inbetalning kundfaktura',
        fxConversion.required && !('error' in fxConversion)
          ? fxConversion.paid_in_invoice_currency
          : undefined,
        paymentAccount,
      )
      for (const line of clearingLines) {
        lines.push({
          account_number: line.account_number,
          debit_amount: line.debit_amount,
          credit_amount: line.credit_amount,
          description: line.line_description ?? '',
        })
      }
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: invoiceAlreadyBooked,
      accounting_method: accountingMethod,
      is_fully_paid: isFullyPaid,
      fx_conversion: fxConversion,
    })
  },
)
