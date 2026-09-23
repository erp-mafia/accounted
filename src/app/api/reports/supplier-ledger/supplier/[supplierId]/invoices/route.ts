import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
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

  const { data: supplier } = await supabase
    .from('suppliers')
    .select('id, name')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!supplier) {
    return NextResponse.json({ error: 'Leverantör saknas' }, { status: 404 })
  }

  // Mirror `generateSupplierLedger`'s filter: registered/approved/partially
  // paid/overdue invoices that still have an outstanding balance.
  //
  // fetchAllRows: bounded by one supplier's OPEN invoices, so the volume is
  // naturally small, but the previous hardcoded 500-row .limit() silently
  // truncated the page for outliers while next_cursor: null claimed the list
  // was complete, and `unconverted_fx_count` was computed over the truncated
  // page (the honesty counter under-reported). The secondary .order('id')
  // gives .range() paging the stable total order it needs (invoice_date is
  // not unique).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoices: any[]
  try {
    invoices = await fetchAllRows(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select(`
          id,
          supplier_invoice_number,
          invoice_date,
          due_date,
          total,
          paid_amount,
          remaining_amount,
          currency,
          exchange_rate,
          registration_journal_entry_id
        `)
        .eq('company_id', companyId)
        .eq('supplier_id', supplierId)
        .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
        .order('invoice_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to)
    )
  } catch (err) {
    return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
  }

  // Pull the registration entries in one batch to get voucher numbers.
  const entryIds = invoices
    .map((i) => i.registration_journal_entry_id)
    .filter((id): id is string => !!id)
  const entryMap = new Map<
    string,
    { voucher_number: number; voucher_series: string; description: string | null; entry_date: string }
  >()
  if (entryIds.length > 0) {
    const { data: entries } = await supabase
      .from('journal_entries')
      .select('id, voucher_number, voucher_series, description, entry_date')
      .eq('company_id', companyId)
      .in('id', entryIds)
      .in('status', ['posted', 'reversed'])
    for (const e of entries || []) {
      entryMap.set(e.id, {
        voucher_number: e.voucher_number,
        voucher_series: e.voucher_series || 'A',
        description: e.description,
        entry_date: e.entry_date,
      })
    }
  }

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
    const entry = inv.registration_journal_entry_id
      ? entryMap.get(inv.registration_journal_entry_id)
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
      // over the FULL row set now that the query paginates.
      unconverted_fx_count: lines.filter((l) => l.remaining_sek === null).length,
      // Kept for response-shape compatibility. Truthful now: every open
      // invoice for the supplier is in `lines`, so there is never a next page.
      next_cursor: null,
    },
  })
})
