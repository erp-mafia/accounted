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
import { buildSupplierBankMatchLines } from '@/lib/bookkeeping/supplier-bank-match-entry'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { planSupplierBankMatch } from '@/lib/invoices/apply-supplier-payment'
import type { SupplierInvoice } from '@/types'
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

    const si = invoice as SupplierInvoice
    const siAlreadyBooked = !!si.registration_journal_entry_id

    // The POST's own plan (planSupplierBankMatch): this preview is what the
    // user approves, so it refuses exactly where the commit refuses (an
    // overshoot past the fee cap, a missing rate, a kontantmetoden partial)
    // and otherwise shows the lines the commit books, from the same builder
    // with the same inputs (buildSupplierBankMatchLines): the 3740
    // öresavrundning, the 6570 bank fee, the kursdifferens and the invoice's
    // dimensions on every leg.
    const planned = planSupplierBankMatch({ invoice: si, transaction, accountingMethod })
    if (!planned.ok) {
      return errorResponseFromCode(planned.code, log, { requestId, details: planned.details })
    }
    const { plan } = planned

    let built: ReturnType<typeof buildSupplierBankMatchLines>
    try {
      built = buildSupplierBankMatchLines(si, plan.booking, paymentAccount)
    } catch (err) {
      // The cash builder routes every leg through toSekOrThrow, which refuses
      // a foreign invoice with no usable rate rather than posting it as if
      // 1 EUR = 1 SEK. The POST returns the same code for the same row, so the
      // dialog can't display amounts the commit will reject.
      if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
        return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
          requestId,
          details: { invoice_currency: si.currency },
        })
      }
      throw err
    }

    const previewLines: PreviewLine[] = built.lines.map((l) => ({
      account_number: l.account_number,
      debit_amount: l.debit_amount,
      credit_amount: l.credit_amount,
      description: l.line_description ?? '',
      // What the grid holds is what gets booked: a row the user edits keeps
      // the bag it came with.
      ...(l.dimensions && Object.keys(l.dimensions).length > 0 ? { dimensions: l.dimensions } : {}),
    }))

    return NextResponse.json({
      entry_type: plan.booking.kind,
      lines: previewLines,
      invoice_already_booked: siAlreadyBooked,
      accounting_method: accountingMethod,
      // Drives the dialog's "markeras som betald" / öresavrundning copy.
      is_fully_paid: plan.isFullyPaid,
      ore_rounding: built.oreDiffSek !== 0,
      bank_fee_sek: plan.bankFeeSek,
      // The settled invoice's bag, for a row the user adds while editing.
      document_dimensions: coerceDimensionsBag(si.default_dimensions),
    })
  },
)
