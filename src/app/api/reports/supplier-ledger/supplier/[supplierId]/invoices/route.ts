import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import {
  fetchSupplierLedgerInvoices,
  type SupplierLedgerInvoice,
} from '@/lib/reports/supplier-ledger-invoices'
import type { ReportSourceLine } from '@/lib/reports/source-lines'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/reports/supplier-ledger/supplier/[supplierId]/invoices
 *
 * Returns the supplier invoices behind a supplier's outstanding balance.
 * Each row's `journal_entry_id` points at the registration journal entry
 * (when posted) so the UI can link to `/bookkeeping/[id]`.
 *
 * Currency contract (mirrors `generateSupplierLedger`): `credit` is the open
 * balance on 2440 and is therefore always SEK. A foreign-currency invoice with
 * no `exchange_rate` has no known SEK amount, so it gets `remaining_sek: null`
 * and `credit: 0` instead of its raw foreign amount, and is counted in
 * `unconverted_fx_count`. A consumer tells the two apart on `remaining_sek`:
 * `null` means "SEK value unknown, excluded from the ledger totals", `0` means
 * "genuinely settled". `remaining` (+ `currency`) always carries the invoice's
 * own-currency amount, so the row stays visible and readable either way.
 */
export const GET = withRouteContext<{ params: Promise<{ supplierId: string }> }>(
  'report.supplier_ledger.invoices',
  async (request, { supabase, companyId }, { params }) => {
  const { supplierId } = await params

  // Verify the supplier belongs to the company, and read its open invoices
  // beside it: the live leverantörsreskontra population of the supplier
  // (supplier-ledger-invoices.ts, the same read generateSupplierLedger
  // makes), each with its registration verifikat. Every open invoice is
  // listed, so `unconverted_fx_count` covers the full row set and there is
  // never a next page.
  const [{ data: supplier }, read] = await Promise.all([
    supabase
      .from('suppliers')
      .select('id, name')
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .maybeSingle(),
    fetchSupplierLedgerInvoices(supabase, companyId, { supplierId }).then(
      (rows) => ({ rows, error: null }),
      (error: unknown) => ({ rows: [] as SupplierLedgerInvoice[], error }),
    ),
  ])

  if (!supplier) {
    return NextResponse.json({ error: 'Leverantör saknas' }, { status: 404 })
  }

  if (read.error) {
    return NextResponse.json({ error: getUserErrorMessage(read.error) }, { status: 500 })
  }

  // By invoice date, then id (the population comes in id order and the sort
  // is stable).
  const invoices = [...read.rows].sort((a, b) =>
    a.invoice_date < b.invoice_date ? -1 : a.invoice_date > b.invoice_date ? 1 : 0
  )

  const lines: (ReportSourceLine & {
    supplier_invoice_id: string
    supplier_invoice_number: string
    /** Open amount in the invoice's own currency. Display only: never summed. */
    remaining: number
    /** `remaining` in SEK, or `null` when the FX rate is missing. */
    remaining_sek: number | null
    currency: string
    paid_amount: number
    due_date: string
  })[] = invoices.map((inv) => {
    const registration = inv.registration_entry
    const entry = registration
      ? { ...registration, voucher_series: registration.voucher_series || 'A' }
      : undefined

    const remaining = Number(inv.remaining_amount) || 0
    const isFx = inv.currency && inv.currency !== 'SEK'
    const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
    const remainingSek =
      isFx && !hasRate
        ? null
        : resolveSekAmount(remaining, null, inv.currency, inv.exchange_rate)

    return {
      journal_entry_id: inv.registration_journal_entry_id || '',
      voucher_number: entry?.voucher_number ?? 0,
      voucher_series: entry?.voucher_series ?? 'A',
      date: inv.invoice_date || entry?.entry_date || '',
      description:
        entry?.description ??
        `Leverantörsfaktura ${inv.supplier_invoice_number || ''}`,
      debit: 0,
      // For an unpaid AP entry, the open balance is a credit on 2440, which is
      // posted in SEK. With no rate there is no SEK figure to show: fall back
      // to 0 rather than to the foreign amount, which would render as kronor in
      // the Kredit column. `remaining_sek: null` is what marks the difference
      // between "unknown" and "settled".
      credit: remainingSek ?? 0,
      supplier_invoice_id: inv.id,
      supplier_invoice_number: inv.supplier_invoice_number || '',
      remaining,
      remaining_sek: remainingSek,
      currency: inv.currency || 'SEK',
      paid_amount: Number(inv.paid_amount) || 0,
      due_date: inv.due_date,
    }
  })

  return NextResponse.json({
    data: {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      lines,
      // Same contract as the ledger report itself: the rows are listed, but
      // their SEK value is unknown and missing from every SEK total. Computed
      // over the full row set.
      unconverted_fx_count: lines.filter((l) => l.remaining_sek === null).length,
      // Kept for response-shape compatibility. Truthful now: every open
      // invoice for the supplier is in `lines`, so there is never a next page.
      next_cursor: null,
    },
  })
})
