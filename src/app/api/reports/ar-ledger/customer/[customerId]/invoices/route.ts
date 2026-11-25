import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { fetchArLedgerInvoices, type ArLedgerInvoice } from '@/lib/reports/ar-ledger-invoices'
import { creditNoteCreditUsed, outstandingWithCreditUsed } from '@/lib/reports/credit-note-settlement'
import { fetchCreditedInvoiceIds, netCreditedPairs } from '@/lib/reports/credited-pairs'
import {
  liveReceivableOutstanding,
  skatteverketSettledByInvoice,
} from '@/lib/bookkeeping/skatteverket-share'
import type { ReportSourceLine } from '@/lib/reports/source-lines'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { issueRoundingOf, withIssueRounding } from '@/lib/reports/issue-rounding-carried'

/**
 * GET /api/reports/ar-ledger/customer/[customerId]/invoices
 *
 * Returns the invoices that contribute to a customer's outstanding balance.
 * Each row exposes the registration journal entry (if any) via
 * `journal_entry_id`, so the UI can link directly to `/bookkeeping/[id]`.
 * That is the invoice engine's own entry, or else the verifikat the invoice
 * is linked to (invoices.journal_entry_id): an invoice migrated or registered
 * from the books was booked by an imported verifikat (crm#1094).
 *
 * If an invoice has no posted registration entry yet (still draft), the
 * `journal_entry_id` is null and the UI must fall back to `/invoices/[id]`.
 *
 * The rows are the live kundreskontra population of the customer, read with
 * their verifikat in one call (ar-ledger-invoices.ts), so the UI sees the
 * same set the aggregate is built from. Every open invoice is listed, so
 * `next_cursor` is always null.
 */

export const GET = withRouteContext<{ params: Promise<{ customerId: string }> }>(
  'report.ar_ledger.customer_invoices',
  async (request, { supabase, companyId }, { params }) => {
  const { customerId } = await params

  // Verify customer belongs to the company, and read its invoices beside it.
  const [{ data: customer }, read] = await Promise.all([
    supabase
      .from('customers')
      .select('id, name')
      .eq('id', customerId)
      .eq('company_id', companyId)
      .maybeSingle(),
    fetchArLedgerInvoices(supabase, companyId, { customerId }).then(
      (rows) => ({ rows, error: null }),
      (error: unknown) => ({ rows: [] as ArLedgerInvoice[], error }),
    ),
  ])

  if (!customer) {
    return NextResponse.json({ error: 'Kund saknas' }, { status: 404 })
  }

  if (read.error) {
    return NextResponse.json({ error: getUserErrorMessage(read.error) }, { status: 500 })
  }

  // The population already leaves settled credit notes out, as in
  // generateARLedger. Listed by invoice date, as the ledger's detail rows
  // read.
  const population = [...read.rows].sort((a, b) =>
    a.invoice_date < b.invoice_date ? -1 : a.invoice_date > b.invoice_date ? 1 : 0
  )
  // Credit a credit note used to pay another invoice, as in generateARLedger.
  const creditUsed = creditNoteCreditUsed(population)
  // Skatteverket's payouts on ROT/RUT deductions, as in generateARLedger.
  const settled = skatteverketSettledByInvoice(population)
  const ownOutstanding = new Map(
    population.map((inv) => [
      inv.id,
      outstandingWithCreditUsed(
        liveReceivableOutstanding(
          inv,
          // With the öresavrundning the issue verifikat booked, as in generateARLedger.
          withIssueRounding(inv, roundOre((Number(inv.total) || 0) - (Number(inv.paid_amount) || 0))),
          settled.get(inv.id)
        ),
        creditUsed.get(inv.id)
      ),
    ])
  )
  // Each credit note set against the invoice it credits, as in generateARLedger.
  const creditNoteIds = population.filter(isCreditNoteDocument).map((inv) => inv.id)
  const paired = netCreditedPairs(
    population,
    ownOutstanding,
    creditNoteIds.length > 0 ? await fetchCreditedInvoiceIds(supabase, companyId, creditNoteIds) : new Map<string, string>()
  )
  const outstandingOf = paired.outstanding
  // A paid invoice is only read for a deduction Skatteverket has yet to pay
  // out: once it has, the invoice is not a receivable; a credited invoice
  // with nothing left and a used-up credit note are settled by credit (as in
  // generateARLedger).
  const invoices = population.filter(
    (inv) =>
      !(
        outstandingOf.get(inv.id) === 0 &&
        (inv.status === 'paid' || inv.status === 'credited' || paired.settledByCredit.has(inv.id))
      )
  )

  // The registration journal entry of each invoice: the invoice engine's own
  // (source_type 'invoice_created'), or else the verifikat the invoice is
  // linked to (invoices.journal_entry_id), which is how an invoice booked
  // outside the invoice engine (an imported verifikat, linked by the
  // provider migration or a registration) is found. The population read
  // resolves it per invoice.
  const entryMap = new Map<
    string,
    { id: string; voucher_number: number; voucher_series: string; description: string | null }
  >()
  for (const inv of invoices) {
    const e = inv.voucher
    if (!e) continue
    entryMap.set(inv.id, {
      id: e.id,
      voucher_number: e.voucher_number,
      voucher_series: e.voucher_series || 'A',
      description: e.description,
    })
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
    const total = roundOre((Number(inv.total) || 0) + issueRoundingOf(inv))
    const outstanding = outstandingOf.get(inv.id) as number
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
      // total - outstanding, as generateARLedger reports it, so a credit
      // note's used credit reads as paid in both.
      paid_amount: roundOre(total - outstanding),
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
