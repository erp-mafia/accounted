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
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import { buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-entries'
import { buildInvoiceMatchClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import type { CreateJournalEntryLineInput, Currency, EntityType, Invoice } from '@/types'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
  /** The line's dimension bag, as the POST books it; absent when untagged. */
  dimensions?: Record<string, string>
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
      // The customer's name is part of the booked row texts.
      .select('*, customer:customers(name), items:invoice_items(*)')
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
    const entityType: EntityType = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)

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

    // Mirrors the POST handler's guard. transactions.amount is denominated in
    // transactions.currency; the SEK value lives in amount_sek (pre-computed at
    // ingest) or is derivable from exchange_rate. A foreign row carrying
    // neither (the shape a row gets when the Riksbanken lookup failed at
    // ingest, see lib/transactions/ingest.ts) has no establishable SEK value,
    // and the raw foreign number must never stand in for one: the dialog would
    // preview a 500 USD receipt as a 500 SEK verifikat. Refuse here too so the
    // preview never shows lines the POST would reject.
    const txIsForeign = !!transaction.currency && transaction.currency !== 'SEK'
    if (
      txIsForeign &&
      transaction.amount_sek == null &&
      !(transaction.exchange_rate != null && transaction.exchange_rate > 0)
    ) {
      return errorResponseFromCode('MATCH_INVOICE_TX_FX_RATE_MISSING', log, {
        requestId,
        details: {
          transactionCurrency: transaction.currency,
          transactionDate: transaction.date,
        },
      })
    }
    // Actual SEK that hit the bank, resolved through the same helper
    // buildInvoicePaymentClearingLines uses for the bank leg. SEK rows return
    // Math.abs(amount) unchanged.
    const txAbsSek =
      Math.round(
        resolveSekAmount(
          Math.abs(transaction.amount),
          transaction.amount_sek != null ? Math.abs(transaction.amount_sek) : null,
          transaction.currency,
          transaction.exchange_rate,
        ) * 100,
      ) / 100

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

    // The POST handler rejects cash-method partials and part-paid completions
    // for never-booked invoices, so refuse to preview lines it will never
    // book. Skipped while the FX rate is unresolved: the dialog must still
    // render to collect a manual rate, and the POST recomputes the real check.
    if (!fxRateUnavailable) {
      const cashBlock = cashPartialBlockReason({
        invoiceAlreadyBooked,
        accountingMethod,
        priorPaidAmount: (invoice as { paid_amount?: number | null }).paid_amount,
        paysRemainingInFull: isFullyPaid,
      })
      if (cashBlock) {
        return errorResponseFromCode('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED', log, {
          requestId,
          details: { reason: cashBlock },
        })
      }
    }

    // The rows come from the builders the POST books with, fed the POST's
    // arguments, so what the dialog shows (and what an edited row starts
    // from) is what gets booked: texts, amounts and the invoice's dimensions.
    // A foreign invoice with no booking rate makes either builder refuse
    // (MATCH_INVOICE_BOOKING_RATE_MISSING / INVOICE_FX_RATE_MISSING), exactly
    // where the POST refuses.
    const inv = invoice as Invoice & { customer?: { name?: string | null } | null }
    let entryType: 'clearing' | 'cash' = 'clearing'
    let booked: CreateJournalEntryLineInput[]

    if (useCashEntry) {
      entryType = 'cash'
      booked = buildInvoiceCashLines(inv, entityType, inv.customer?.name ?? undefined, paymentAccount).lines
    } else {
      booked = buildInvoiceMatchClearingLines(
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
          invoice_number: inv.invoice_number,
          customer: inv.customer,
          default_dimensions: inv.default_dimensions,
        },
        fxConversion.required && !('error' in fxConversion)
          ? fxConversion.paid_in_invoice_currency
          : undefined,
        paymentAccount,
      ).lines
    }

    const lines: PreviewLine[] = booked.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      description: line.line_description ?? '',
      // A row the user edits keeps the bag it came with.
      ...(line.dimensions && Object.keys(line.dimensions).length > 0
        ? { dimensions: line.dimensions }
        : {}),
    }))

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: invoiceAlreadyBooked,
      accounting_method: accountingMethod,
      is_fully_paid: isFullyPaid,
      fx_conversion: fxConversion,
      // The settled invoice's bag, for a row the user adds while editing.
      document_dimensions: coerceDimensionsBag(inv.default_dimensions),
    })
  },
)
