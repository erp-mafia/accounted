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
 *
 * A company that books invoices in a separate step (defer_invoice_booking)
 * gets an unbooked invoice's sale booked first by the POST, through the Bokför
 * step (lib/invoices/sale-first.ts): `sale_entry` is that verifikat as the
 * step's dry run builds it, and `lines` the payment that clears it. A refusal
 * there is the POST's refusal too.
 *
 * `overpayment_account` (optional): where a SEK customer's excess of a krona
 * or more goes, as the POST takes it. Without it such a match previews no
 * rows and `overpayment` names the excess and the accounts that may take it,
 * since the POST refuses it until the user picks one (crm#1045).
 *
 * `fee_account` (optional, 6570): the mirror for a SEK payment a krona or more
 * SHORT of what the invoice owes, by less than the fee cap: the payment
 * provider's fee withheld from its payout (crm#1364). `payment_fee` names the
 * shortfall and the account the preview was asked for (null until the user
 * names it). Without the account the match is a partial payment, except on a
 * kontantmetod invoice that was never booked: the POST refuses that partial,
 * so the preview shows no rows and `payment_fee.required` until the user
 * names the fee.
 */
import { NextResponse } from 'next/server'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { buildInvoiceCashLines } from '@/lib/bookkeeping/invoice-entries'
import { invoiceCashBankSek } from '@/lib/bookkeeping/invoice-lines'
import { buildInvoiceMatchClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import {
  CUSTOMER_ADVANCE_ACCOUNT,
  OVERPAYMENT_ACCOUNTS,
  overpaymentAllowed,
} from '@/lib/bookkeeping/overpayment'
import {
  PAYMENT_FEE_ACCOUNT,
  paymentFeeAllowed,
  paymentFeeShortfall,
} from '@/lib/bookkeeping/payment-fee'
import { ORE_ROUNDING_ACCOUNT, roundOre } from '@/lib/money'
import { planMatchPayment } from '@/lib/invoices/match-payment-plan'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { planSaleBeforeSettlement } from '@/lib/invoices/sale-first'
import { sessionFailureResponse } from '@/lib/operations/session'
import type { CreateJournalEntryLineInput, Currency, EntityType, Invoice } from '@/types'
import { z } from 'zod'
import { requireAccountingMethod } from '@/lib/company/accounting-method'

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
  overpayment_account: z.enum([CUSTOMER_ADVANCE_ACCOUNT, ORE_ROUNDING_ACCOUNT]).optional(),
  fee_account: z.enum([PAYMENT_FEE_ACCOUNT]).optional(),
})

export const GET = withRouteContext(
  'transaction.match_invoice_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, user, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({
      invoice_id: url.searchParams.get('invoice_id'),
      overpayment_account: url.searchParams.get('overpayment_account') ?? undefined,
      fee_account: url.searchParams.get('fee_account') ?? undefined,
    })
    if (!parsed.success) {
      const issueField = parsed.error.issues[0]?.path[0]
      const field =
        issueField === 'overpayment_account' || issueField === 'fee_account' ? issueField : 'invoice_id'
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          field,
          message:
            field === 'invoice_id'
              ? 'invoice_id must be a UUID'
              : field === 'fee_account'
                ? `fee_account must be ${PAYMENT_FEE_ACCOUNT}`
                : `overpayment_account must be ${CUSTOMER_ADVANCE_ACCOUNT} or ${ORE_ROUNDING_ACCOUNT}`,
        },
      })
    }
    const { invoice_id, overpayment_account, fee_account } = parsed.data

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

    const settingsRead = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    // The preview shows the verifikat the match will post: an unreadable
    // method refuses rather than show a shape it may not book (accounted#58).
    const accountingMethod = requireAccountingMethod(settingsRead)
    const entityType: EntityType = await resolveCompanyEntityType(supabase, companyId, settingsRead.data?.entity_type)

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
    // A rate-unavailable cross-currency payment can't be resolved to invoice
    // currency yet, so never report fully-paid (or preview the cash shape) on
    // a guess: the dialog blocks confirm until a manual rate is entered and
    // the POST recomputes the real figure.
    const fxRateUnavailable = fxConversion.required && 'error' in fxConversion
    // The POST's own payment step on the same inputs: the overshoot guard,
    // the öresavrundning band (a sub-krona remainder settles in full on 3740)
    // and a named overpayment account. A private copy of that math here once
    // counted any overpayment as fully paid and previewed a booking the POST
    // refused (crm#1045).
    const pureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'
    const payment = fxRateUnavailable
      ? null
      : planMatchPayment(invoice, paidAmount, {
          pureSek,
          overpaymentAccount: overpayment_account,
          feeAccount: fee_account,
        })
    // The excess of a SEK customer who paid a krona or more too much and has
    // not named its account yet: nothing is bookable until they do.
    let unplacedExcess: number | null = null
    if (payment && !payment.ok) {
      if (payment.code !== 'MATCH_AMOUNT_EXCEEDS_REMAINING' || !payment.absorbsOre) {
        return errorResponseFromCode(payment.code, log, { requestId, details: payment.details })
      }
      unplacedExcess = payment.details.excess
    }
    // Any account the user may name settles the invoice in full.
    const isFullyPaid = unplacedExcess !== null || (payment?.ok === true && payment.plan.isFullyPaid)
    const overpayment =
      unplacedExcess !== null
        ? { excess: unplacedExcess, account: null }
        : payment?.ok && payment.overpayment
          ? { excess: payment.overpayment.amount, account: payment.overpayment.account }
          : null

    // A SEK payment short of the remaining amount by what could be the
    // payment provider's fee, before the user named it one (crm#1364): the
    // dialog offers the fee account.
    let unplacedFee: number | null = null
    if (payment?.ok && !payment.plan.isFullyPaid && pureSek && !fee_account) {
      const remaining = roundOre(invoice.remaining_amount ?? invoice.total - (invoice.paid_amount || 0))
      const shortfall = paymentFeeShortfall(remaining, paidAmount)
      if (shortfall > 0 && paymentFeeAllowed(PAYMENT_FEE_ACCOUNT, shortfall, remaining)) unplacedFee = shortfall
    }

    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id

    // The POST handler rejects cash-method partials and part-paid completions
    // for never-booked invoices, so refuse to preview lines it will never
    // book. Skipped while the FX rate is unresolved: the dialog must still
    // render to collect a manual rate, and the POST recomputes the real check.
    // A partial short by what could be the provider's fee is not refused: the
    // fee account settles it in full, so the dialog asks for it first.
    const blockWhen = (paysRemainingInFull: boolean) =>
      cashPartialBlockReason({
        invoiceAlreadyBooked,
        accountingMethod,
        priorPaidAmount: (invoice as { paid_amount?: number | null }).paid_amount,
        paysRemainingInFull,
      })
    // The payment could not be booked as the partial it is without the fee.
    const partialRefused = !fxRateUnavailable && blockWhen(false) !== null && blockWhen(true) === null
    let feeRequired = false
    if (!fxRateUnavailable) {
      const cashBlock = blockWhen(isFullyPaid)
      if (cashBlock && unplacedFee !== null && partialRefused) {
        feeRequired = true
      } else if (cashBlock) {
        return errorResponseFromCode('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED', log, {
          requestId,
          details: { reason: cashBlock },
        })
      }
    }
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && (isFullyPaid || feeRequired)
    const feeAccount = payment?.ok ? payment.fee?.account : undefined
    const paymentFee =
      payment?.ok && payment.fee
        ? { fee: payment.fee.amount, account: payment.fee.account, required: partialRefused }
        : unplacedFee !== null
          ? { fee: unplacedFee, account: null, required: feeRequired }
          : null

    // The POST books a deferring company's unbooked invoice first, through
    // the Bokför step: its dry run is every check that booking runs, and the
    // verifikat the dialog shows above the payment.
    const salePlan = await planSaleBeforeSettlement(
      { supabase, companyId: companyId!, userId: user.id, log },
      invoice,
      { settlementDate: transaction.date },
    )
    if (!salePlan.ok) return sessionFailureResponse(salePlan, log, requestId)

    // The rows come from the builders the POST books with, fed the POST's
    // arguments, so what the dialog shows (and what an edited row starts
    // from) is what gets booked: texts, amounts and the invoice's dimensions.
    // A foreign invoice with no booking rate makes either builder refuse
    // (MATCH_INVOICE_BOOKING_RATE_MISSING / INVOICE_FX_RATE_MISSING), exactly
    // where the POST refuses.
    const inv = invoice as Invoice & { customer?: { name?: string | null } | null }
    let entryType: 'clearing' | 'cash' = 'clearing'
    let booked: CreateJournalEntryLineInput[]

    if (useCashEntry) entryType = 'cash'
    if (unplacedExcess !== null || feeRequired) {
      booked = []
    } else if (useCashEntry) {
      booked = buildInvoiceCashLines(
        inv, entityType, inv.customer?.name ?? undefined, paymentAccount,
        invoiceCashBankSek(transaction),
        overpayment?.account ?? undefined,
        { deferDeductionShare: accountingMethod === 'cash', feeAccount },
      ).lines
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
        overpayment?.account ?? undefined,
        feeAccount,
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
      // The sale verifikat the POST books first (defer_invoice_booking).
      books_sale_first: salePlan.required,
      sale_entry: salePlan.required ? salePlan.entry : null,
      // A SEK excess of a krona or more: the accounts that may take it and
      // the one the user named (null until then, with no rows above).
      overpayment: overpayment && {
        excess: overpayment.excess,
        accounts: OVERPAYMENT_ACCOUNTS.filter((account) => overpaymentAllowed(account, overpayment.excess)),
        account: overpayment.account,
      },
      // A SEK payment short by what could be the payment provider's fee: the
      // fee and the account named (null until then); `required` when the
      // match cannot be booked as a partial payment instead (kontantmetoden,
      // never booked): with no account named there are no rows above.
      payment_fee: paymentFee,
    })
  },
)
