/**
 * GET /api/supplier-invoices/[id]/mark-paid/preview?amount=...&payment_account=...&amount_sek=...
 *
 * Read-only preview of the journal entries mark-paid would post. Mirrors the
 * POST handler's routing: if the SI has a registration JE, payment clears
 * 2440. Under kontantmetoden a never-booked invoice books expense + input VAT
 * here. A deferring company's unbooked invoice (defer_invoice_booking) is
 * booked first by the Bokför step: `registration_entry` is that verifikat, as
 * its dry run builds it, and `lines` the payment that clears it
 * (lib/supplier-invoices/registration-first.ts). `amount` is in the
 * invoice's currency; the lines are SEK, and `clearing_sek` / `paid_sek` say
 * what leaves 2440 and the payment account.
 *
 * Every refusal is the POST's own: both run planSupplierSettlement
 * (lib/invoices/settle-supplier-payment.ts), so the dialog says why before
 * anything is typed. Only the rows are this route's.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  buildSupplierInvoiceCashLines,
  buildSupplierInvoicePaymentLines,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { planSupplierSettlement, type SettleableSupplierInvoice } from '@/lib/invoices/settle-supplier-payment'
import { roundOre } from '@/lib/money'
import { sessionFailureResponse } from '@/lib/operations/session'
import { ISO_DATE_RE } from '@/lib/invariants'
import type { CreateJournalEntryLineInput } from '@/types'

type PreviewLine = {
  account_number: string
  debit_amount: number
  credit_amount: number
  description: string
  /** The line's dimension bag, as the POST books it; absent when untagged. */
  dimensions?: Record<string, string>
}

// What the grid holds is what gets booked: a row the user edits keeps the
// bag it came with.
function toPreviewLine(l: CreateJournalEntryLineInput): PreviewLine {
  return {
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    description: l.line_description ?? '',
    ...(l.dimensions && Object.keys(l.dimensions).length > 0 ? { dimensions: l.dimensions } : {}),
  }
}

const QuerySchema = z.object({
  amount: z.coerce.number().positive(),
  payment_account: z.string().min(1).optional(),
  // The SEK that left the payment account, as the POST body's amount_sek.
  amount_sek: z.coerce.number().positive().optional(),
  // The POST body's payment_date; omitted, today, as in the POST.
  payment_date: z.string().regex(ISO_DATE_RE).optional(),
})

export const GET = withRouteContext(
  'supplier_invoice.mark_paid_preview',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx

    const url = new URL(request.url)
    const parsed = QuerySchema.safeParse({
      amount: url.searchParams.get('amount'),
      payment_account: url.searchParams.get('payment_account') ?? undefined,
      amount_sek: url.searchParams.get('amount_sek') ?? undefined,
      payment_date: url.searchParams.get('payment_date') ?? undefined,
    })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId })
    }
    const { amount, payment_account, amount_sek, payment_date } = parsed.data

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

    // The duplicate warning is the POST's alone: it has a dialog of its own, and
    // the rows stay worth showing beside a bank row that may be this payment.
    // Force past it here books nothing.
    const planned = await planSupplierSettlement(
      { supabase, companyId: companyId!, userId: user.id, log },
      invoice as SettleableSupplierInvoice,
      { amount, amountSek: amount_sek, paymentDate: payment_date, paymentAccount: payment_account || undefined, force: true },
    )
    if (!planned.ok) return sessionFailureResponse(planned, log, requestId)
    const { plan } = planned

    const creditAccount = plan.paymentAccount

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'
    // SEK off 2440 (clearing only) and SEK credited to the payment account.
    let clearingSek: number | null = null
    let paidSek: number

    if (plan.useCashEntry) {
      entryType = 'cash'
      // The lines come from buildSupplierInvoiceCashLines, the same pure
      // builder the POST handler's createSupplierInvoiceCashEntry books from,
      // with the same inputs (no bank row is known on this door, so no
      // settledBankSek). This preview used to re-model the entry by hand and
      // had drifted from it (a non-existent expense_account, VAT subtracted
      // from an ex-VAT line_total, no reverse-charge or SLP lines, no 3740).
      // A SEK invoice with display-only öresavrundning now previews the
      // whole-krona payment and the 3740 residual the POST will book (#2852).
      const si = plan.invoice
      try {
        const built = buildSupplierInvoiceCashLines(
          si,
          si.items ?? [],
          si.supplier?.supplier_type || 'swedish_business',
          {
            supplierName: si.supplier?.name ?? undefined,
            paymentAccount: creditAccount,
            settledBankSek: amount_sek,
            // As createSupplierInvoiceCashEntry reads them for the POST.
            chartVatTreatments: si.reverse_charge ? await fetchChartVatTreatments(supabase, companyId!) : undefined,
          },
        )
        lines.push(...built.lines.map(toPreviewLine))
        paidSek = built.bankSek
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
      // Clearing: the lines createSupplierInvoicePaymentEntry books for the
      // POST's arguments (Dr 2440 / Cr the payment account, the invoice's
      // dimensions on both legs), in the SEK the plan resolved: the
      // invoice-currency amount was once previewed (and booked) as if it were
      // kronor (#2955).
      const built = buildSupplierInvoicePaymentLines(plan.invoice, {
        paymentAmount: plan.clearingSek,
        exchangeRateDifference: plan.exchangeRateDifference,
        supplierName: plan.invoice.supplier?.name ?? undefined,
        paymentAccount: creditAccount,
      })
      lines.push(...built.lines.map(toPreviewLine))
      clearingSek = plan.clearingSek
      paidSek = roundOre(plan.clearingSek - (plan.exchangeRateDifference ?? 0))
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: plan.invoiceAlreadyBooked,
      accounting_method: plan.accountingMethod,
      // The registration verifikat the POST books before the payment, or null.
      books_registration_first: plan.registration.required,
      registration_entry: plan.registration.required ? plan.registration.entry : null,
      // The amount is in the invoice's currency; every line is SEK.
      currency: invoice.currency,
      clearing_sek: clearingSek,
      paid_sek: paidSek,
      // The settled invoice's bag, for a row the user adds while editing.
      document_dimensions: coerceDimensionsBag(invoice.default_dimensions),
    })
  },
)
