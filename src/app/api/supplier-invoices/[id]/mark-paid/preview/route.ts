/**
 * GET /api/supplier-invoices/[id]/mark-paid/preview?amount=...&payment_account=...
 *
 * Read-only preview of the journal entry mark-paid would post. Mirrors the
 * POST handler's routing: if the SI has a registration JE, payment clears
 * 2440. Otherwise (kontantmetoden + never booked), expense + input VAT
 * book here.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolveSupplierInvoicePaymentSek } from '@/lib/bookkeeping/supplier-payment-amounts'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import {
  buildSupplierInvoiceCashLines,
  DEFAULT_SUPPLIER_PAYMENT_ACCOUNT,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
}

const QuerySchema = z.object({
  amount: z.coerce.number().positive(),
  payment_account: z.string().min(1).optional(),
})

export const GET = withRouteContext(
  'supplier_invoice.mark_paid_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({
      amount: url.searchParams.get('amount'),
      payment_account: url.searchParams.get('payment_account') ?? undefined,
    })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    }
    const { amount, payment_account } = parsed.data

    const { data: invoice, error: invErr } = await supabase
      .from('supplier_invoices')
      // supplier_type drives the reverse-charge lines of the cash entry and the
      // name goes into its line text, as in the POST handler.
      .select('*, supplier:suppliers(supplier_type, name), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()
    if (invErr || !invoice) {
      return errorResponseFromCode('MATCH_INVOICE_NOT_FOUND', log, { requestId })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, last_supplier_payment_account')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const creditAccount =
      payment_account ||
      (settings as { last_supplier_payment_account?: string } | null)?.last_supplier_payment_account ||
      DEFAULT_SUPPLIER_PAYMENT_ACCOUNT

    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // The POST handler rejects cash-method partials and part-paid completions
    // for never-booked invoices (the cash builder books the full invoice), so
    // refuse to preview lines it will never book.
    const remainingForGuard =
      (invoice as { remaining_amount?: number | null }).remaining_amount ?? invoice.total
    const cashBlock = cashPartialBlockReason({
      invoiceAlreadyBooked: siAlreadyBooked,
      accountingMethod,
      priorPaidAmount: (invoice as { paid_amount?: number | null }).paid_amount,
      paysRemainingInFull: amount >= remainingForGuard - 0.005,
    })
    if (cashBlock) {
      return errorResponseFromCode('SI_CASH_PARTIAL_UNSUPPORTED', log, {
        requestId,
        details: { reason: cashBlock },
      })
    }

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'

    if (useCashEntry) {
      entryType = 'cash'
      // The lines come from buildSupplierInvoiceCashLines, the same pure
      // builder the POST handler's createSupplierInvoiceCashEntry books from,
      // with the same inputs (no bank row is known on this door, so no
      // settledBankSek). This preview used to re-model the entry by hand and
      // had drifted from it (a non-existent expense_account, VAT subtracted
      // from an ex-VAT line_total, no reverse-charge or SLP lines, no 3740).
      // A SEK invoice with display-only öresavrundning now previews the
      // whole-krona payment and the 3740 residual the POST will book (#2852).
      const si = invoice as SupplierInvoice & {
        items?: SupplierInvoiceItem[]
        supplier?: { supplier_type?: string | null; name?: string | null } | null
      }
      try {
        const built = buildSupplierInvoiceCashLines(
          si,
          si.items ?? [],
          si.supplier?.supplier_type || 'swedish_business',
          { supplierName: si.supplier?.name ?? undefined, paymentAccount: creditAccount },
        )
        for (const l of built.lines) {
          lines.push({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            description: l.line_description ?? '',
          })
        }
      } catch (err) {
        // Same refusal the POST handler gives a foreign invoice with no usable
        // rate (toSekOrThrow), instead of previewing 1 EUR as 1 kr.
        if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
          return errorResponseFromCode('SI_FX_RATE_MISSING', log, {
            requestId,
            details: { invoice_currency: si.currency },
          })
        }
        throw err
      }
    } else {
      const rounded = await resolveSupplierInvoicePaymentSek(supabase, companyId!, invoice, amount)
      if (rounded == null) {
        return errorResponseFromCode('SI_FX_RATE_MISSING', log, { requestId })
      }
      lines.push({
        account_number: '2440',
        debit_amount: rounded,
        credit_amount: 0,
        description: 'Kvittning leverantörsskuld',
      })
      lines.push({
        account_number: creditAccount,
        debit_amount: 0,
        credit_amount: rounded,
        description: 'Utbetalning',
      })
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: siAlreadyBooked,
      accounting_method: accountingMethod,
    })
  },
)
