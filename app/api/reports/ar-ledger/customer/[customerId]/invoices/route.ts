import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import type { ReportSourceLine } from '@/lib/reports/source-lines'

/**
 * GET /api/reports/ar-ledger/customer/[customerId]/invoices
 *
 * Returns the invoices that contribute to a customer's outstanding balance.
 * Each row exposes the registration journal entry (if any) via
 * `journal_entry_id`, so the UI can link directly to `/bookkeeping/[id]`.
 *
 * If an invoice has no posted registration entry yet (still draft), the
 * `journal_entry_id` is null and the UI must fall back to `/invoices/[id]`.
 */
const PAGE_LIMIT = 500

export const GET = withRouteContext<{ params: Promise<{ customerId: string }> }>(
  'report.ar_ledger.customer_invoices',
  async (request, { supabase, companyId }, { params }) => {
  const { customerId } = await params

  // Verify customer belongs to the company.
  const { data: customer } = await supabase
    .from('customers')
    .select('id, name')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (!customer) {
    return NextResponse.json({ error: 'Kund saknas' }, { status: 404 })
  }

  // Pull this customer's outstanding invoices. Mirrors the filter in
  // `generateARLedger` so the UI sees the same set the aggregate is built
  // from.
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      id,
      invoice_number,
      invoice_date,
      due_date,
      total,
      paid_amount,
      currency,
      exchange_rate,
      remaining_amount,
      notes
    `)
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .in('status', ['sent', 'overdue', 'credited'])
    .order('invoice_date', { ascending: true })
    .limit(PAGE_LIMIT)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // For each invoice, find the registration journal entry (source_type =
  // 'invoice_created', source_id = invoice.id). We batch them to keep this
  // a single DB roundtrip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoices = (data || []) as any[]
  const ids = invoices.map((i) => i.id)
  const entryMap = new Map<
    string,
    { id: string; voucher_number: number; voucher_series: string; description: string | null }
  >()

  if (ids.length > 0) {
    const { data: entries } = await supabase
      .from('journal_entries')
      .select('id, voucher_number, voucher_series, description, source_id')
      .eq('company_id', companyId)
      .eq('source_type', 'invoice_created')
      .in('source_id', ids)
      .in('status', ['posted', 'reversed'])

    for (const e of entries || []) {
      entryMap.set(e.source_id, {
        id: e.id,
        voucher_number: e.voucher_number,
        voucher_series: e.voucher_series || 'A',
        description: e.description,
      })
    }
  }

  // Shape each invoice as a ReportSourceLine. The "debit" column carries
  // the outstanding SEK amount (it's a receivable on 1510); "credit" is 0
  // unless the invoice is fully a credit note.
  const lines: (ReportSourceLine & {
    invoice_id: string
    invoice_number: string | null
    outstanding: number
    outstanding_sek: number | null
    currency: string
    paid_amount: number
    due_date: string
  })[] = invoices.map((inv) => {
    const entry = entryMap.get(inv.id)
    const paidAmount = Number(inv.paid_amount) || 0
    const total = Number(inv.total) || 0
    const outstanding = Math.round((total - paidAmount) * 100) / 100
    const isFx = inv.currency && inv.currency !== 'SEK'
    const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
    const outstandingSek =
      isFx && !hasRate
        ? null
        : resolveSekAmount(outstanding, null, inv.currency, inv.exchange_rate)

    return {
      journal_entry_id: entry?.id ?? '',
      voucher_number: entry?.voucher_number ?? 0,
      voucher_series: entry?.voucher_series ?? 'A',
      date: inv.invoice_date || '',
      description:
        entry?.description ?? `Faktura ${inv.invoice_number || '(utkast)'}`,
      debit: outstandingSek ?? outstanding,
      credit: 0,
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      outstanding,
      outstanding_sek: outstandingSek,
      currency: inv.currency || 'SEK',
      paid_amount: paidAmount,
      due_date: inv.due_date,
    }
  })

  return NextResponse.json({
    data: {
      customer_id: customer.id,
      customer_name: customer.name,
      lines,
      next_cursor: null,
    },
  })
})
