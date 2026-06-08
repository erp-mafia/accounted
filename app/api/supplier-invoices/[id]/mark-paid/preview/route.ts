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
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
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
      .select('*, items:supplier_invoice_items(*)')
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
      '1930'

    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'

    if (useCashEntry) {
      entryType = 'cash'
      const si = invoice as SupplierInvoice & { items?: SupplierInvoiceItem[] }
      const items = si.items ?? []
      let totalAmountSek = 0
      let totalVatSek = 0
      if (items.length > 0) {
        for (const it of items) {
          const lineTotal = resolveSekAmount(it.line_total, null, si.currency, si.exchange_rate)
          const vat = resolveSekAmount(it.vat_amount, null, si.currency, si.exchange_rate)
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
        const subSek = resolveSekAmount(si.subtotal, si.subtotal_sek, si.currency, si.exchange_rate)
        const vatSek = resolveSekAmount(si.vat_amount, si.vat_amount_sek, si.currency, si.exchange_rate)
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
        account_number: creditAccount,
        debit_amount: 0,
        credit_amount: Math.round(totalAmountSek * 100) / 100,
        description: 'Utbetalning',
      })
    } else {
      const rounded = Math.round(amount * 100) / 100
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
