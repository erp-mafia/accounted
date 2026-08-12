/**
 * GET /api/transactions/[id]/match-supplier-invoice/preview?supplier_invoice_id=...
 *
 * Read-only preview of the journal entry lines that match-supplier-invoice
 * would create. Mirrors the routing decision in the POST handler: if the
 * supplier invoice already has a registration JE (2440 posted at receipt),
 * payment clears 2440. Only true kontantmetoden SIs (no registration JE)
 * book expense + input VAT here.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { generateSlpLines, isSlpPensionAccount } from '@/lib/bookkeeping/slp-lines'
import { buildSupplierPaymentClearingLines } from '@/lib/bookkeeping/supplier-payment-lines'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { ORE_TOLERANCE } from '@/lib/money'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

const QuerySchema = z.object({
  supplier_invoice_id: z.string().uuid(),
})

export const GET = withRouteContext(
  'transaction.match_supplier_invoice_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({
      supplier_invoice_id: url.searchParams.get('supplier_invoice_id'),
    })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'supplier_invoice_id', message: 'supplier_invoice_id must be a UUID' },
      })
    }
    const { supplier_invoice_id } = parsed.data

    const { data: transaction, error: txErr } = await supabase
      .from('transactions')
      // amount_sek is needed for the cash-method preview: a foreign-currency
      // settlement is translated at the payment-date rate (the SEK that left
      // the bank), mirroring the committed verifikat from the POST handler.
      // cash_account_id resolves which BAS account this bank line actually
      // settles from, mirroring the POST handler's settlement-account lookup.
      .select('id, date, amount, currency, amount_sek, cash_account_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()
    if (txErr || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    const { data: invoice, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('*, items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', companyId)
      .single()
    if (invErr || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', log, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'

    // Same resolution as the POST handler: credit the cash account this
    // transaction is actually linked to, never the sticky
    // last_supplier_payment_account (that setting reflects the manual
    // mark-paid/private-funds flow, not a real matched bank transaction).
    const paymentAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      log,
    )

    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    const si = invoice as SupplierInvoice & { items?: SupplierInvoiceItem[] }

    // Amount resolution, byte-identical to the POST handler: same inputs, same
    // `Math.round(x * 100) / 100` form. This preview is what the user approves
    // in the dialog, so any divergence here means one number is approved and a
    // different one is booked.
    const txAmountAbs = Math.abs(transaction.amount)
    const remainingInvoiceCurrency = si.remaining_amount ?? si.total
    // In the INVOICE's currency: a cross-currency match settles whatever
    // remains rather than reading the bank figure as invoice currency.
    const paymentAmountInvoiceCurrency =
      transaction.currency === si.currency ? txAmountAbs : remainingInvoiceCurrency
    // SEK that actually left the bank, when known. SEK bank line → the absolute
    // amount; foreign line with a stored amount_sek → that value; foreign line
    // WITHOUT amount_sek → unknown (null). The raw foreign amount must never
    // stand in: that is what renders 19 USD as 19 kr.
    const bankSekStored =
      transaction.currency === 'SEK'
        ? txAmountAbs
        : transaction.amount_sek != null
          ? Math.abs(transaction.amount_sek)
          : null
    const invoiceFxRate = si.exchange_rate ?? null
    // SEK the invoice was booked at for this payment portion; null when the
    // invoice is foreign and carries no exchange_rate.
    const bookedSek =
      si.currency === 'SEK'
        ? paymentAmountInvoiceCurrency
        : invoiceFxRate && invoiceFxRate > 0
          ? Math.round(paymentAmountInvoiceCurrency * invoiceFxRate * 100) / 100
          : null
    const actualBankSek = bankSekStored ?? bookedSek
    if (actualBankSek == null) {
      // Neither side yields a SEK figure (foreign bank line without amount_sek
      // paying a foreign invoice without exchange_rate). The POST handler
      // refuses this row with the same code, so refuse here instead of
      // previewing a 1:1 number that can never be committed.
      return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
        requestId,
        details: {
          transaction_currency: transaction.currency,
          invoice_currency: si.currency,
        },
      })
    }
    const originalBookedSek = bookedSek ?? actualBankSek
    const exchangeRateDifference =
      Math.round((originalBookedSek - actualBankSek) * 100) / 100
    const fullSettlement =
      transaction.currency !== si.currency ||
      txAmountAbs >= remainingInvoiceCurrency - 0.005

    // The POST handler rejects cash-method partials and part-paid completions
    // for never-booked invoices (the cash builder books the full invoice), so
    // refuse to preview lines it will never book.
    const cashBlock = cashPartialBlockReason({
      invoiceAlreadyBooked: siAlreadyBooked,
      accountingMethod,
      priorPaidAmount: (si as { paid_amount?: number | null }).paid_amount,
      paysRemainingInFull: fullSettlement,
    })
    if (cashBlock) {
      return errorResponseFromCode('SI_CASH_PARTIAL_UNSUPPORTED', log, {
        requestId,
        details: { reason: cashBlock },
      })
    }

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'
    // Drives the dialog's "markeras som betald" / öresavrundning copy. Cash
    // entries always book the full invoice, so they default to fully paid.
    let isFullyPaid = true
    let oreRounding = false

    if (useCashEntry) {
      entryType = 'cash'
      const items = si.items ?? []

      // Kontantmetoden books the expense AT PAYMENT at the payment-date rate.
      // The POST handler passes createSupplierInvoiceCashEntry a settledBankSek
      // override only for a full foreign settlement whose rate actually moved;
      // the builder then derives its rate as settledBankSek / invoice.total and
      // otherwise keeps the invoice's stored rate. Mirror that derivation
      // exactly (createSupplierInvoiceCashEntry's `effectiveRate`).
      const settledBankSek =
        exchangeRateDifference !== 0 && fullSettlement ? actualBankSek : undefined
      const cashRate =
        settledBankSek != null && settledBankSek > 0 && si.currency !== 'SEK' && si.total > 0
          ? settledBankSek / si.total
          : si.exchange_rate
      // The builder routes every leg through toSekOrThrow, which refuses a
      // foreign invoice with no usable rate rather than posting it as if
      // 1 EUR = 1 SEK. Refuse the same rows here so the dialog can't display
      // amounts the commit will reject.
      if (si.currency !== 'SEK' && !(cashRate != null && cashRate > 0)) {
        return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
          requestId,
          details: { invoice_currency: si.currency },
        })
      }

      // Mirror createSupplierInvoiceCashEntry: per-item expense debit + VAT
      // debit + bank credit. We only need a faithful preview, not exact
      // account-mapping fidelity: show one aggregate expense line per item
      // (or a single fallback line if items are missing).
      let totalAmountSek = 0
      let totalVatSek = 0
      if (items.length > 0) {
        for (const it of items) {
          const lineTotal = resolveSekAmount(it.line_total, null, si.currency, cashRate)
          const vat = resolveSekAmount(it.vat_amount, null, si.currency, cashRate)
          const expenseAcct = (it as { expense_account?: string | null }).expense_account ?? '4000'
          lines.push({
            account_number: expenseAcct,
            debit_amount: Math.round((lineTotal - vat) * 100) / 100,
            credit_amount: 0,
            description: it.description ?? 'Kostnad',
          })
          totalAmountSek += lineTotal
          totalVatSek += vat
        }
      } else {
        // Pass null for the pre-computed SEK so cashRate (payment-date rate)
        // drives the translation: resolveSekAmount would otherwise prefer the
        // invoice-rate *_sek columns and ignore the rate.
        const subSek = resolveSekAmount(si.subtotal, null, si.currency, cashRate)
        const vatSek = resolveSekAmount(si.vat_amount, null, si.currency, cashRate)
        lines.push({
          account_number: '4000',
          debit_amount: Math.round(subSek * 100) / 100,
          credit_amount: 0,
          description: 'Kostnad',
        })
        totalAmountSek = subSek + vatSek
        totalVatSek = vatSek
      }

      if (totalVatSek > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: Math.round(totalVatSek * 100) / 100,
          credit_amount: 0,
          description: 'Ingående moms',
        })
      }

      // Mirror createSupplierInvoiceCashEntry's SLP pair: items flagged
      // apply_slp on a 741x pension account book 7533 D / 2514 K at the same
      // rate the expense lines above use. The pair nets to zero, so the bank
      // credit below is untouched; without it the dialog shows fewer lines
      // than the POST actually books.
      let slpBase = 0
      for (const it of items) {
        if (it.apply_slp !== true) continue
        if (!isSlpPensionAccount(it.account_number)) continue
        slpBase += resolveSekAmount(it.line_total, null, si.currency, cashRate)
      }
      if (slpBase > 0) {
        for (const l of generateSlpLines(slpBase)) {
          lines.push({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
          })
        }
      }

      lines.push({
        account_number: paymentAccount,
        debit_amount: 0,
        credit_amount: Math.round(totalAmountSek * 100) / 100,
        description: 'Utbetalning från bank',
      })
    } else {
      // Clearing: Dr 2440 / Cr 1930 (or chosen payment account).
      const isPureSek = transaction.currency === 'SEK' && si.currency === 'SEK'
      if (isPureSek) {
        // Shared builder so the previewed lines (including any 3740
        // öresavrundning row) are byte-identical to what the POST commits.
        const { lines: clearingLines, oreDiffSek } = buildSupplierPaymentClearingLines({
          apSek: remainingInvoiceCurrency,
          bankSek: txAmountAbs,
          paymentAccount,
        })
        for (const l of clearingLines) {
          lines.push({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
          })
        }
        oreRounding = oreDiffSek !== 0
        // Full settlement when the öre residual is absorbed or the bank covers
        // the whole remaining; a ≥1 kr short payment leaves a partial.
        isFullyPaid = oreRounding || txAmountAbs >= remainingInvoiceCurrency - ORE_TOLERANCE
      } else {
        // Foreign leg under faktureringsmetoden. createSupplierInvoicePaymentEntry
        // clears 2440 at the SEK the leverantörsskuld was BOOKED at and credits
        // the bank with the SEK that actually moved, booking the difference as
        // kursvinst (3960) or kursförlust (7960). The old preview showed a single
        // min(bankSEK, invoiceSEK) figure on both legs and no FX line, so the
        // bank credit the user approved differed from the committed one by
        // exactly the kursdifferens (and, with no conversion inputs at all,
        // showed the raw foreign amount as kronor).
        lines.push({
          account_number: '2440',
          debit_amount: Math.round(originalBookedSek * 100) / 100,
          credit_amount: 0,
          description: 'Kvittning leverantörsskuld',
        })
        lines.push({
          account_number: paymentAccount,
          debit_amount: 0,
          credit_amount: Math.round(actualBankSek * 100) / 100,
          description: 'Utbetalning från bank',
        })
        if (exchangeRateDifference > 0) {
          lines.push({
            account_number: '3960',
            debit_amount: 0,
            credit_amount: Math.round(Math.abs(exchangeRateDifference) * 100) / 100,
            description: 'Valutakursvinst',
          })
        } else if (exchangeRateDifference < 0) {
          lines.push({
            account_number: '7960',
            debit_amount: Math.round(Math.abs(exchangeRateDifference) * 100) / 100,
            credit_amount: 0,
            description: 'Valutakursförlust',
          })
        }
        // Mirrors planSupplierPayment without öre absorption (the accrual FX
        // path never absorbs): a cross-currency match is clamped to the
        // remaining balance and therefore always settles in full; a
        // same-currency foreign match settles when the bank amount covers it.
        isFullyPaid =
          paymentAmountInvoiceCurrency >= remainingInvoiceCurrency - ORE_TOLERANCE
      }
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: siAlreadyBooked,
      accounting_method: accountingMethod,
      is_fully_paid: isFullyPaid,
      ore_rounding: oreRounding,
    })
  },
)
