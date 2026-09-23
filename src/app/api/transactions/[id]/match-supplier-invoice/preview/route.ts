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
import { buildSupplierInvoiceCashLines } from '@/lib/bookkeeping/supplier-invoice-entries'
import { buildSupplierPaymentClearingLines } from '@/lib/bookkeeping/supplier-payment-lines'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { planSupplierPayment } from '@/lib/invoices/apply-supplier-payment'
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
      // supplier_type drives the reverse-charge lines of the cash entry, as in
      // the POST handler.
      .select('*, supplier:suppliers(supplier_type), items:supplier_invoice_items(*)')
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

    const si = invoice as SupplierInvoice & {
      items?: SupplierInvoiceItem[]
      supplier?: { supplier_type?: string | null } | null
    }

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
    // Same decision as the POST handler (planSupplierPayment with öre
    // absorption on pure SEK): a whole-krona bank row within the öre band of
    // the remaining balance settles in full, under both methods. An overshoot
    // the POST will reject still previews as a full settlement, as before.
    const isPureSek = transaction.currency === 'SEK' && si.currency === 'SEK'
    const paymentPlan = planSupplierPayment(
      { total: si.total, paid_amount: si.paid_amount, remaining_amount: remainingInvoiceCurrency },
      paymentAmountInvoiceCurrency,
      { absorbOreRounding: isPureSek },
    )
    const fullSettlement =
      transaction.currency !== si.currency || !paymentPlan.ok || paymentPlan.plan.isFullyPaid

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
      // The lines come from buildSupplierInvoiceCashLines, the same pure
      // builder createSupplierInvoiceCashEntry books from, with the same
      // settledBankSek the POST handler passes. This preview used to re-model
      // the entry by hand and had drifted from it (one line per item on a
      // non-existent expense_account, VAT subtracted from an ex-VAT
      // line_total, no reverse-charge lines, no 3740): the user approved one
      // verifikat and another was booked.
      //
      // settledBankSek: a foreign invoice is pinned to the payment-date rate
      // (the SEK that left the bank); on a pure-SEK match a sub-krona
      // difference to the invoice total is booked on 3740 (öresavrundning).
      try {
        const built = buildSupplierInvoiceCashLines(
          si,
          si.items ?? [],
          si.supplier?.supplier_type || 'swedish_business',
          {
            paymentAccount,
            settledBankSek:
              (isPureSek || exchangeRateDifference !== 0) && fullSettlement
                ? actualBankSek
                : undefined,
          },
        )
        for (const l of built.lines) {
          lines.push({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
          })
        }
        oreRounding = built.oreDiffSek !== 0
      } catch (err) {
        // The builder routes every leg through toSekOrThrow, which refuses a
        // foreign invoice with no usable rate rather than posting it as if
        // 1 EUR = 1 SEK. The POST handler returns the same code for the same
        // row, so the dialog can't display amounts the commit will reject.
        if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
          return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
            requestId,
            details: { invoice_currency: si.currency },
          })
        }
        throw err
      }
    } else {
      // Clearing: Dr 2440 / Cr 1930 (or chosen payment account).
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
