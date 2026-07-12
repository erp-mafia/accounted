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
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
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

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'
    // Drives the dialog's "markeras som betald" / öresavrundning copy. Cash
    // entries always book the full invoice, so they default to fully paid.
    let isFullyPaid = true
    let oreRounding = false

    if (useCashEntry) {
      entryType = 'cash'
      const si = invoice as SupplierInvoice & { items?: SupplierInvoiceItem[] }
      const items = si.items ?? []

      // Kontantmetoden books the expense AT PAYMENT at the payment-date rate
      // (the SEK that actually left the bank), so translate this preview the
      // same way the committed verifikat does. The bank SEK is only known when
      // the transaction is in SEK or carries a stored amount_sek; for a foreign
      // transaction without it we fall back to the invoice's own rate (the raw
      // foreign amount must never be used: that would render 19 USD as 19 kr).
      const bankSek =
        transaction.currency === 'SEK'
          ? Math.abs(transaction.amount)
          : transaction.amount_sek != null
            ? Math.abs(transaction.amount_sek)
            : null
      const cashRate =
        bankSek != null && si.currency !== 'SEK' && si.total > 0
          ? bankSek / si.total
          : si.exchange_rate

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

      lines.push({
        account_number: paymentAccount,
        debit_amount: 0,
        credit_amount: Math.round(totalAmountSek * 100) / 100,
        description: 'Utbetalning från bank',
      })
    } else {
      // Clearing: Dr 2440 / Cr 1930 (or chosen payment account).
      const si = invoice as SupplierInvoice
      const isPureSek = transaction.currency === 'SEK' && si.currency === 'SEK'
      if (isPureSek) {
        // Shared builder so the previewed lines (including any 3740
        // öresavrundning row) are byte-identical to what the POST commits.
        const remainingSek = si.remaining_amount ?? si.total
        const bankSek = Math.abs(transaction.amount)
        const { lines: clearingLines, oreDiffSek } = buildSupplierPaymentClearingLines({
          apSek: remainingSek,
          bankSek,
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
        isFullyPaid = oreRounding || bankSek >= remainingSek - ORE_TOLERANCE
      } else {
        const amountSek = resolveSekAmount(
          Math.abs(transaction.amount),
          null,
          transaction.currency,
          null,
        )
        const total = resolveSekAmount(si.total, si.total_sek, si.currency, si.exchange_rate)
        const amount = Math.round(Math.min(amountSek, total) * 100) / 100
        lines.push({
          account_number: '2440',
          debit_amount: amount,
          credit_amount: 0,
          description: 'Kvittning leverantörsskuld',
        })
        lines.push({
          account_number: paymentAccount,
          debit_amount: 0,
          credit_amount: amount,
          description: 'Utbetalning från bank',
        })
        isFullyPaid = amount >= total - ORE_TOLERANCE
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
