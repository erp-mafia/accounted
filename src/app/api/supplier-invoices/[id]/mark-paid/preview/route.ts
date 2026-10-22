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
 * what leaves 2440 and the payment account. `payment_date`, when given, is
 * checked for an open period the way the POST checks it.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import {
  resolveSupplierPaymentSek,
  supplierPaymentSekInputIssue,
} from '@/lib/bookkeeping/supplier-payment-amounts'
import {
  buildSupplierInvoiceCashLines,
  buildSupplierInvoicePaymentLines,
  DEFAULT_SUPPLIER_PAYMENT_ACCOUNT,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { roundOre } from '@/lib/money'
import { findSignedBankPayment, signedBankPaymentDetails } from '@/lib/payments/orders/signed-payment'
import { sessionFailureResponse } from '@/lib/operations/session'
import { planRegistrationBeforeSettlement } from '@/lib/supplier-invoices/registration-first'
import { ISO_DATE_RE } from '@/lib/invariants'
import type { CreateJournalEntryLineInput, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import { requireAccountingMethod } from '@/lib/company/accounting-method'

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
  // The POST body's payment_date: checked for an open period when the
  // invoice's registration is booked first.
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

    // The POST refuses a payment beside a signed bank payment (crm#1243); the
    // dialog shows that refusal from the preview, before anything is typed.
    const signedBankPayment = await findSignedBankPayment(supabase, companyId, id)
    if (signedBankPayment) {
      return errorResponseFromCode('SI_BANK_PAYMENT_UNDER_WAY', log, {
        requestId,
        details: signedBankPaymentDetails(signedBankPayment),
      })
    }

    const sekInputIssue = supplierPaymentSekInputIssue({ currency: invoice.currency, amountSek: amount_sek })
    if (sekInputIssue) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: sekInputIssue })
    }

    const settingsRead = await supabase
      .from('company_settings')
      .select('accounting_method, last_supplier_payment_account')
      .eq('company_id', companyId)
      .single()
    const settings = settingsRead.data

    // The preview shows the verifikat the payment will post: an unreadable
    // method refuses rather than show a shape it may not book (accounted#58).
    const accountingMethod = requireAccountingMethod(settingsRead)
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

    // The POST books a deferring company's unbooked invoice first, through
    // the Bokför step: its dry run is every check that booking runs, and the
    // verifikat the dialog shows above the payment. A refusal there is the
    // POST's refusal too.
    const registrationPlan = await planRegistrationBeforeSettlement(
      { supabase, companyId: companyId!, userId: user.id, log },
      invoice as SupplierInvoice,
      { settlementDate: payment_date ?? null },
    )
    if (!registrationPlan.ok) return sessionFailureResponse(registrationPlan, log, requestId)

    const lines: PreviewLine[] = []
    let entryType: 'clearing' | 'cash' = 'clearing'
    // SEK off 2440 (clearing only) and SEK credited to the payment account.
    let clearingSek: number | null = null
    let paidSek: number

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
      // dimensions on both legs), in SEK resolved the way the POST resolves
      // it: the invoice-currency amount was once previewed (and booked) as
      // if it were kronor (#2955).
      const si = invoice as SupplierInvoice & { supplier?: { name?: string | null } | null }
      const sek = await resolveSupplierPaymentSek(supabase, companyId!, si, {
        amount,
        amountSek: amount_sek,
        ...(registrationPlan.required ? { pendingRegistrationPayableSek: registrationPlan.payableSek } : {}),
      })
      if (!sek.ok) {
        return errorResponseFromCode(sek.code, log, { requestId, details: sek.details })
      }
      const built = buildSupplierInvoicePaymentLines(si, {
        paymentAmount: sek.clearingSek,
        exchangeRateDifference: sek.exchangeRateDifference,
        supplierName: si.supplier?.name ?? undefined,
        paymentAccount: creditAccount,
      })
      lines.push(...built.lines.map(toPreviewLine))
      clearingSek = sek.clearingSek
      paidSek = roundOre(sek.clearingSek - (sek.exchangeRateDifference ?? 0))
    }

    return NextResponse.json({
      entry_type: entryType,
      lines,
      invoice_already_booked: siAlreadyBooked,
      accounting_method: accountingMethod,
      // The registration verifikat the POST books before the payment, or null.
      books_registration_first: registrationPlan.required,
      registration_entry: registrationPlan.required ? registrationPlan.entry : null,
      // The amount is in the invoice's currency; every line is SEK.
      currency: invoice.currency,
      clearing_sek: clearingSek,
      paid_sek: paidSek,
      // The settled invoice's bag, for a row the user adds while editing.
      document_dimensions: coerceDimensionsBag(invoice.default_dimensions),
    })
  },
)
