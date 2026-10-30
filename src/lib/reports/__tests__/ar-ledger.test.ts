import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { generateARLedger } from '../ar-ledger'

// ============================================================
// The ledger reads its population (get_ar_ledger_invoices) and the register
// coverage (get_invoice_register_coverage) through rpc(); both answer from
// `tables` by their JS ports (tests/reskontra-rpc-port.ts). Rows keep their
// table order, which stands in for id order.
// ============================================================

let tables: ReskontraTables
let failures: Record<string, { message: string }>
const { supabase, calls } = createReskontraClient(() => tables, () => failures)

/** The population read's arguments, as the ledger made it. */
function populationArgs() {
  return calls.find((c) => c.name === 'get_ar_ledger_invoices')?.args
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  tables = {}
  failures = {}
})

describe('generateARLedger', () => {
  it('only reads fakturor: proformas, delivery notes and quotes are not receivables', async () => {
    const open = { customer_id: 'cust-a', customer: { id: 'cust-a', name: 'Acme AB' }, invoice_date: '2024-05-01', due_date: '2024-06-01', total: 1000, paid_amount: 0, currency: 'SEK', status: 'sent' }
    tables = {
      invoices: [
        { ...open, id: 'inv-1', invoice_number: 'F001' },
        { ...open, id: 'inv-2', invoice_number: 'P001', document_type: 'proforma' },
        { ...open, id: 'inv-3', invoice_number: 'D001', document_type: 'delivery_note' },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(populationArgs()).toEqual({ p_company_id: 'company-1', p_as_of_date: null, p_customer_id: null })
    expect(report.entries[0].invoices.map((i) => i.invoice_number)).toEqual(['F001'])
    expect(report.total_outstanding).toBe(1000)
  })

  it('returns empty report when no invoices found', async () => {
    tables = { invoices: [] }

    const report = await generateARLedger(supabase, 'company-1')
    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
    expect(report.unpaid_count).toBe(0)
  })

  it('returns empty report on query error', async () => {
    failures = { get_ar_ledger_invoices: { message: 'DB error' } }

    const report = await generateARLedger(supabase, 'company-1')
    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('groups invoices by customer with correct aging buckets', async () => {
    // Reference date: 2024-06-15
    const asOfDate = '2024-06-15'

    tables = {
      invoices: [
        // Customer A: one current, one 1-30 days overdue
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Acme AB' },
          invoice_number: 'F001',
          invoice_date: '2024-05-01',
          due_date: '2024-06-20', // not yet due
          total: 5000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
        },
        {
          id: 'inv-2',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Acme AB' },
          invoice_number: 'F002',
          invoice_date: '2024-04-01',
          due_date: '2024-06-01', // 14 days overdue
          total: 3000,
          paid_amount: 1000,
          currency: 'SEK',
          status: 'overdue',
        },
        // Customer B: 90+ days overdue
        {
          id: 'inv-3',
          customer_id: 'cust-b',
          customer: { id: 'cust-b', name: 'Beta Corp' },
          invoice_number: 'F003',
          invoice_date: '2024-01-01',
          due_date: '2024-02-01', // 135 days overdue
          total: 10000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'overdue',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', asOfDate)

    expect(report.unpaid_count).toBe(3)
    expect(report.entries).toHaveLength(2)

    // Sorted by total outstanding descending: Beta Corp (10000), then Acme (7000)
    expect(report.entries[0].customer_name).toBe('Beta Corp')
    expect(report.entries[0].total_outstanding).toBe(10000)
    expect(report.entries[0].days_90_plus).toBe(10000)

    expect(report.entries[1].customer_name).toBe('Acme AB')
    expect(report.entries[1].total_outstanding).toBe(7000)
    expect(report.entries[1].current).toBe(5000)     // inv-1
    expect(report.entries[1].days_1_30).toBe(2000)    // inv-2 (3000 - 1000 paid)
    expect(report.entries[1].invoices).toHaveLength(2)

    // Totals
    expect(report.total_outstanding).toBe(17000)
    expect(report.total_current).toBe(5000)
    expect(report.total_overdue).toBe(12000)
  })

  it('computes outstanding as total minus paid_amount', async () => {
    tables = {
      invoices: [
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: 'F001',
          invoice_date: '2024-06-01',
          due_date: '2024-07-01',
          total: 10000,
          paid_amount: 7500,
          currency: 'SEK',
          status: 'sent',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries[0].invoices[0].outstanding).toBe(2500)
    expect(report.total_outstanding).toBe(2500)
  })

  it('sorts invoices within customer by due_date', async () => {
    tables = {
      invoices: [
        {
          id: 'inv-2',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: 'F002',
          invoice_date: '2024-05-01',
          due_date: '2024-07-01',
          total: 1000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
        },
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: 'F001',
          invoice_date: '2024-04-01',
          due_date: '2024-06-01',
          total: 2000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-05-15')

    // Sorted by due_date: F001 (June 1) before F002 (July 1)
    expect(report.entries[0].invoices[0].invoice_number).toBe('F001')
    expect(report.entries[0].invoices[1].invoice_number).toBe('F002')
  })

  it('aggregates foreign-currency invoices into SEK aging buckets but preserves original currency on detail rows', async () => {
    // The aging totals reconcile against account 1510 (SEK), but the per-invoice
    // detail row keeps `outstanding` in invoice currency for display.
    tables = {
      invoices: [
        // 225 EUR at 11 → 2 475 SEK
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Foreign AB' },
          invoice_number: 'F100',
          invoice_date: '2024-05-01',
          due_date: '2024-06-01', // 14 days overdue at 2024-06-15
          total: 225,
          paid_amount: 0,
          currency: 'EUR',
          exchange_rate: 11,
          status: 'overdue',
        },
        // 1 000 SEK (control)
        {
          id: 'inv-2',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Foreign AB' },
          invoice_number: 'F101',
          invoice_date: '2024-05-01',
          due_date: '2024-06-01',
          total: 1000,
          paid_amount: 0,
          currency: 'SEK',
          exchange_rate: null,
          status: 'overdue',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    const entry = report.entries[0]
    // Aging bucket sums in SEK: 2 475 + 1 000 = 3 475
    expect(entry.days_1_30).toBe(3475)
    expect(entry.total_outstanding).toBe(3475)

    // Per-invoice detail keeps original currency for display, with the
    // converted SEK value alongside so callers don't accidentally mix.
    const eurInv = entry.invoices.find(i => i.invoice_number === 'F100')!
    expect(eurInv.outstanding).toBe(225)
    expect(eurInv.currency).toBe('EUR')
    expect(eurInv.outstanding_sek).toBe(2475)

    const sekInv = entry.invoices.find(i => i.invoice_number === 'F101')!
    expect(sekInv.outstanding_sek).toBe(1000)

    expect(report.total_outstanding).toBe(3475)
    expect(report.unconverted_fx_count).toBe(0)
  })

  it('lists FX invoices without exchange_rate but excludes them from totals (outstanding_sek = null)', async () => {
    tables = {
      invoices: [
        // 100 EUR with no rate: listed in detail but excluded from buckets
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Foreign AB' },
          invoice_number: 'F200',
          invoice_date: '2024-05-01',
          due_date: '2024-06-01',
          total: 100,
          paid_amount: 0,
          currency: 'EUR',
          exchange_rate: null,
          status: 'overdue',
        },
        // 500 SEK control
        {
          id: 'inv-2',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Foreign AB' },
          invoice_number: 'F201',
          invoice_date: '2024-05-01',
          due_date: '2024-06-01',
          total: 500,
          paid_amount: 0,
          currency: 'SEK',
          exchange_rate: null,
          status: 'overdue',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.unconverted_fx_count).toBe(1)
    // EUR row excluded from total: only the 500 SEK invoice contributes
    expect(report.total_outstanding).toBe(500)

    const entry = report.entries[0]
    expect(entry.total_outstanding).toBe(500)
    // Both detail rows are still visible to the user
    expect(entry.invoices).toHaveLength(2)
    const eurInv = entry.invoices.find(i => i.invoice_number === 'F200')!
    expect(eurInv.outstanding).toBe(100)
    expect(eurInv.outstanding_sek).toBeNull()
  })

  it('uses Math.round for monetary precision', async () => {
    tables = {
      invoices: [
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test' },
          invoice_number: 'F001',
          invoice_date: '2024-06-01',
          due_date: '2024-07-01',
          total: 100.1,
          paid_amount: 33.33,
          currency: 'SEK',
          status: 'sent',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')
    expect(report.entries[0].invoices[0].outstanding).toBe(66.77)
    expect(report.total_outstanding).toBe(66.77)
  })

  it('nets a credited invoice with its credit note to zero outstanding', async () => {
    // Original was sent (unpaid) and then fully credited.
    // Journal-level AR is 0; the ledger should match.
    tables = {
      invoices: [
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: '2026001',
          invoice_date: '2026-05-05',
          due_date: '2026-06-05',
          total: 1241.25,
          paid_amount: 0,
          currency: 'SEK',
          status: 'credited',
        },
        {
          id: 'inv-2',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: 'KR-2026001',
          invoice_date: '2026-05-05',
          due_date: '2026-05-05',
          total: -1241.25,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
          credited_invoice_id: 'inv-1',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
    expect(report.total_current).toBe(0)
    expect(report.total_overdue).toBe(0)
    expect(report.unpaid_count).toBe(0)
  })

  it('keeps a customer whose open invoices are all unconvertible FX', async () => {
    // Every open invoice lacks an exchange_rate, so nothing reached the aging
    // buckets and the customer's SEK total is 0. That 0 means "unknown", not
    // "settled": the rows are counted in unconverted_fx_count, so they have to
    // be reachable somewhere. Dropping the customer made the PDF/XLSX/web view
    // claim N invoices lack a rate while showing none of them.
    tables = {
      invoices: [
        {
          id: 'inv-1',
          customer_id: 'cust-fx',
          customer: { id: 'cust-fx', name: 'Foreign Only AB' },
          invoice_number: 'F300',
          invoice_date: '2024-05-01',
          due_date: '2024-06-01',
          total: 800,
          paid_amount: 0,
          currency: 'EUR',
          exchange_rate: null,
          status: 'overdue',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.unconverted_fx_count).toBe(1)
    expect(report.entries).toHaveLength(1)

    const entry = report.entries[0]
    expect(entry.customer_name).toBe('Foreign Only AB')
    // Excluded from the SEK totals, but visible.
    expect(entry.total_outstanding).toBe(0)
    expect(entry.invoices).toHaveLength(1)
    expect(entry.invoices[0].outstanding).toBe(800)
    expect(entry.invoices[0].currency).toBe('EUR')
    expect(entry.invoices[0].outstanding_sek).toBeNull()

    // The unconvertible invoice is still an open item.
    expect(report.total_outstanding).toBe(0)
    expect(report.unpaid_count).toBe(1)
  })

  it('separates "nets to zero" from "all unconvertible" in the same report', async () => {
    // Two customers both end at total_outstanding 0 for opposite reasons.
    // The settled one must stay suppressed; the unconvertible one must not.
    tables = {
      invoices: [
        // Customer A: invoice + credit note, genuinely settled.
        {
          id: 'inv-1',
          customer_id: 'cust-net',
          customer: { id: 'cust-net', name: 'Netted AB' },
          invoice_number: '2026001',
          invoice_date: '2026-05-05',
          due_date: '2026-06-05',
          total: 2000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'credited',
        },
        {
          id: 'inv-2',
          customer_id: 'cust-net',
          customer: { id: 'cust-net', name: 'Netted AB' },
          invoice_number: 'KR-2026001',
          invoice_date: '2026-05-05',
          due_date: '2026-05-05',
          total: -2000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
          credited_invoice_id: 'inv-1',
        },
        // Customer B: one open USD invoice, no rate.
        {
          id: 'inv-3',
          customer_id: 'cust-fx',
          customer: { id: 'cust-fx', name: 'Foreign Only AB' },
          invoice_number: 'F400',
          invoice_date: '2026-05-05',
          due_date: '2026-06-05',
          total: 1500,
          paid_amount: 0,
          currency: 'USD',
          exchange_rate: null,
          status: 'sent',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

    expect(report.entries.map((e) => e.customer_name)).toEqual(['Foreign Only AB'])
    expect(report.unconverted_fx_count).toBe(1)
    expect(report.total_outstanding).toBe(0)
  })

  it('keeps a credit note outstanding when it offsets an already-paid invoice', async () => {
    // Original was paid in full, then credited: we owe the customer the refund.
    tables = {
      invoices: [
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: '2026001',
          invoice_date: '2026-04-01',
          due_date: '2026-05-01',
          total: 1000,
          paid_amount: 1000,
          currency: 'SEK',
          status: 'credited',
        },
        {
          id: 'inv-2',
          customer_id: 'cust-a',
          customer: { id: 'cust-a', name: 'Test AB' },
          invoice_number: 'KR-2026001',
          invoice_date: '2026-05-05',
          due_date: '2026-05-05',
          total: -1000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
          credited_invoice_id: 'inv-1',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].total_outstanding).toBe(-1000)
    expect(report.total_outstanding).toBe(-1000)
    expect(report.unpaid_count).toBe(1)
  })

  it('handles missing customer name gracefully', async () => {
    tables = {
      invoices: [
        {
          id: 'inv-1',
          customer_id: 'cust-a',
          customer: null,
          invoice_number: 'F001',
          invoice_date: '2024-06-01',
          due_date: '2024-07-01',
          total: 1000,
          paid_amount: 0,
          currency: 'SEK',
          status: 'sent',
        },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')
    expect(report.entries[0].customer_name).toBe('Okänd kund')
  })
})

describe('generateARLedger: historical as-of reconstruction (#1020)', () => {
  const invoiceBase = {
    customer_id: 'cust-a',
    customer: { id: 'cust-a', name: 'Acme AB' },
    invoice_date: '2024-05-01',
    due_date: '2024-06-01',
    currency: 'SEK',
  }

  it('reopens an invoice whose payment came after the as-of date', async () => {
    tables = {
      invoices: [
        { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 5000, paid_amount: 5000, paid_at: '2024-07-01T10:00:00Z', status: 'paid' },
      ],
      invoice_payments: [{ invoice_id: 'inv-1', amount: 5000, payment_date: '2024-07-01' }],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].invoices[0].outstanding).toBe(5000)
    expect(report.entries[0].invoices[0].paid_amount).toBe(0)
    expect(report.total_outstanding).toBe(5000)
    expect(report.unpaid_count).toBe(1)
  })

  it('reduces outstanding by payments made on or before the as-of date only', async () => {
    tables = {
      invoices: [
        { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 10000, paid_amount: 10000, paid_at: '2024-07-05T10:00:00Z', status: 'paid' },
      ],
      invoice_payments: [
        { invoice_id: 'inv-1', amount: 4000, payment_date: '2024-06-10' },
        { invoice_id: 'inv-1', amount: 6000, payment_date: '2024-07-05' },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries[0].invoices[0].paid_amount).toBe(4000)
    expect(report.entries[0].invoices[0].outstanding).toBe(6000)
    expect(report.total_outstanding).toBe(6000)
  })

  it('keeps an invoice written off after the as-of date, and drops one written off by then', async () => {
    tables = {
      invoices: [
        // Konstaterad on or before the as-of date: off 1510 by then.
        { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 5000, paid_amount: 0, status: 'written_off' },
        // Konstaterad after the as-of date: still an open claim on the day.
        { ...invoiceBase, id: 'inv-2', invoice_number: 'F002', total: 3000, paid_amount: 1000, status: 'written_off' },
        // Konstaterad and annulled (storno) before the as-of date: open.
        { ...invoiceBase, id: 'inv-3', invoice_number: 'F003', total: 2000, paid_amount: 0, status: 'written_off' },
      ],
      invoice_payments: [{ invoice_id: 'inv-2', amount: 1000, payment_date: '2024-06-01' }],
      invoice_write_offs: [
      // Konstaterad decisions: two on or before the as-of date, one after.
      { id: 'w-1', invoice_id: 'inv-1', kind: 'confirmed', reverses_id: null, entry_date: '2024-06-01' },
      { id: 'w-2', invoice_id: 'inv-2', kind: 'confirmed', reverses_id: null, entry_date: '2024-07-01' },
      { id: 'w-3', invoice_id: 'inv-3', kind: 'confirmed', reverses_id: null, entry_date: '2024-05-01' },
      { id: 'w-4', invoice_id: 'inv-3', kind: 'annulled', reverses_id: 'w-3', entry_date: '2024-06-10' },
    ],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    // A backdated read: the population is reconstructed as of the date.
    expect(populationArgs()).toMatchObject({ p_as_of_date: '2024-06-15' })
    const ids = report.entries.flatMap((e) => e.invoices.map((i) => i.invoice_number))
    expect(ids.sort()).toEqual(['F002', 'F003'])
    expect(report.total_outstanding).toBe(4000)
  })

  it('skips invoices already settled by the as-of date', async () => {
    tables = {
      invoices: [
        // Settled before the as-of date: must not appear at all.
        { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 1000, paid_amount: 1000, paid_at: '2024-06-01T10:00:00Z', status: 'paid' },
        // Still open: the only row in the report.
        { ...invoiceBase, id: 'inv-2', invoice_number: 'F002', total: 2000, paid_amount: 0, status: 'sent' },
      ],
      invoice_payments: [],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].invoices).toHaveLength(1)
    expect(report.entries[0].invoices[0].invoice_number).toBe('F002')
    expect(report.total_outstanding).toBe(2000)
    expect(report.unpaid_count).toBe(1)
  })

  it('falls back to paid_at for fully paid invoices without payment rows', async () => {
    tables = {
      invoices: [
        // No payment rows, but paid_at says the payment came after the
        // as-of date: the invoice was open on that date.
        { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 3000, paid_amount: 3000, paid_at: '2024-08-01T10:00:00Z', status: 'paid' },
      ],
      invoice_payments: [],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].invoices[0].outstanding).toBe(3000)
    expect(report.total_outstanding).toBe(3000)
  })

  it('keeps stored paid_amount for undateable legacy partial payments', async () => {
    tables = {
      invoices: [
        // No payment rows and no paid_at: the stored partial amount cannot
        // be dated, so it is assumed to have stood at the as-of date.
        { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 3000, paid_amount: 1000, status: 'sent' },
      ],
      invoice_payments: [],
    }

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries[0].invoices[0].outstanding).toBe(2000)
    expect(report.total_outstanding).toBe(2000)
  })
})

describe('generateARLedger: partially paid invoices (feedback seq 817399)', () => {
  // Invoice 2026024 from the report: 15 625 invoiced, one payment of 15 000
  // on 2026-07-01, 625 still open. The ledger used to drop it entirely.
  const partiallyPaid = {
    id: 'inv-pp',
    customer_id: 'cust-s',
    customer: { id: 'cust-s', name: 'Kunden AB' },
    invoice_number: '2026024',
    invoice_date: '2026-06-01',
    due_date: '2026-07-01',
    total: 15625,
    paid_amount: 15000,
    remaining_amount: 625,
    paid_at: null,
    currency: 'SEK',
    status: 'partially_paid',
  }
  const payment = { invoice_id: 'inv-pp', amount: 15000, payment_date: '2026-07-01' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('live view lists it with the unpaid remainder outstanding', async () => {
    tables = {
      invoices: [partiallyPaid],
    }

    const report = await generateARLedger(supabase, 'company-1')

    // The live population: no as-of date.
    expect(populationArgs()).toMatchObject({ p_as_of_date: null })
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].customer_name).toBe('Kunden AB')
    expect(report.entries[0].invoices[0]).toMatchObject({
      invoice_number: '2026024',
      total: 15625,
      paid_amount: 15000,
      outstanding: 625,
      outstanding_sek: 625,
    })
    // Due 2026-07-01: 89 days overdue on the pinned today.
    expect(report.entries[0].days_61_90).toBe(625)
    expect(report.total_outstanding).toBe(625)
    expect(report.total_overdue).toBe(625)
    expect(report.unpaid_count).toBe(1)
  })

  it('historical view before the payment date reopens the full total', async () => {
    tables = {
      invoices: [partiallyPaid],
      invoice_payments: [payment],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-06-30')

    expect(populationArgs()).toMatchObject({ p_as_of_date: '2026-06-30' })
    expect(report.entries[0].invoices[0].paid_amount).toBe(0)
    expect(report.entries[0].invoices[0].outstanding).toBe(15625)
    expect(report.total_outstanding).toBe(15625)
  })

  it('historical view on or after the payment date shows the remainder', async () => {
    tables = {
      invoices: [partiallyPaid],
      invoice_payments: [payment],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-07-01')

    expect(populationArgs()).toMatchObject({ p_as_of_date: '2026-07-01' })
    expect(report.entries[0].invoices[0].paid_amount).toBe(15000)
    expect(report.entries[0].invoices[0].outstanding).toBe(625)
    expect(report.total_outstanding).toBe(625)
    expect(report.unpaid_count).toBe(1)
  })
})

describe('generateARLedger: migrated credit notes', () => {
  // The provider migration imports every kreditfaktura as status 'credited'
  // with nothing paid or remaining; Accounted's own credit notes are 'sent'.
  const base = {
    customer_id: 'cust-a',
    customer: { id: 'cust-a', name: 'Callidus Tech AB' },
    invoice_date: '2026-02-13',
    due_date: '2026-03-15',
    currency: 'SEK',
  }
  const migratedCreditNote = (id: string, total: number, credited_invoice_id: string | null = null) => ({
    ...base,
    id,
    invoice_number: id,
    total,
    paid_amount: 0,
    remaining_amount: 0,
    status: 'credited',
    credited_invoice_id,
  })

  it('leaves out an unlinked credit note whose original was imported as paid', async () => {
    // Invoice 5 came in as paid and is not in the population; 1510 is 0.
    tables = {
      invoices: [migratedCreditNote('6', -11615)],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
    expect(report.unpaid_count).toBe(0)
  })

  it('leaves out a linked credit note whose original is credited and fully paid', async () => {
    tables = {
      invoices: [
        { ...base, id: 'orig', invoice_number: '10', total: 5000, paid_amount: 5000, status: 'credited' },
        migratedCreditNote('cn', -5000, 'orig'),
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('counts a partial credit once: the provider netted it into the original', async () => {
    // Faktura 9 694, krediterad med 4 847 i källsystemet: the original arrives
    // with paid_amount 4 847 carrying the credit, so 4 847 is still owed.
    tables = {
      invoices: [
        { ...base, id: 'orig', invoice_number: '5922', total: 9694, paid_amount: 4847, status: 'sent' },
        migratedCreditNote('cn', -4847, 'orig'),
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.total_outstanding).toBe(4847)
    expect(report.entries[0].invoices.map((inv) => inv.invoice_id)).toEqual(['orig'])
  })

  it('keeps the open invoices of the same customer', async () => {
    tables = {
      invoices: [
        { ...base, id: 'open', invoice_number: '12', total: 1000, paid_amount: 0, status: 'sent' },
        migratedCreditNote('cn', -11615),
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.total_outstanding).toBe(1000)
    expect(report.entries[0].invoices.map((inv) => inv.invoice_id)).toEqual(['open'])
  })

  it('does not touch an in-app credit note, which is issued as sent', async () => {
    tables = {
      invoices: [
        { ...base, id: 'orig', invoice_number: '13', total: 1000, paid_amount: 1000, status: 'credited' },
        { ...base, id: 'cn', invoice_number: '14', total: -1000, paid_amount: 0, status: 'sent', credited_invoice_id: 'orig' },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.total_outstanding).toBe(-1000)
  })
})

describe('generateARLedger: a credit note set off against a new invoice (crm#1059)', () => {
  // F-1 was paid, then credited in full by KR-F-1: the customer has a credit
  // of 40 000 on 1510. The new invoice F-2 (50 000) is settled against that
  // credit by linking KR-F-1's own verifikat to it (link_invoice_to_voucher),
  // so F-2 has 10 000 left and 1510 stands at 10 000. Nothing is stored on
  // the credit note: the set-off is the payment row naming its verifikat.
  const base = {
    customer_id: 'cust-a',
    customer: { id: 'cust-a', name: 'Kunden AB' },
    currency: 'SEK',
    exchange_rate: null,
  }
  const original = {
    ...base, id: 'orig', invoice_number: 'F-1', invoice_date: '2026-09-01', due_date: '2026-10-01',
    total: 40000, paid_amount: 40000, paid_at: '2026-09-05T12:00:00Z', status: 'credited', journal_entry_id: 'je-orig',
  }
  const creditNote = {
    ...base, id: 'cn', invoice_number: 'KR-F-1', invoice_date: '2026-09-10', due_date: '2026-09-10',
    total: -40000, paid_amount: null, remaining_amount: 0, status: 'sent', credited_invoice_id: 'orig', journal_entry_id: 'je-cn',
  }
  const newInvoice = {
    ...base, id: 'new', invoice_number: 'F-2', invoice_date: '2026-09-20', due_date: '2026-10-20',
    total: 50000, paid_amount: 40000, remaining_amount: 10000, status: 'partially_paid', journal_entry_id: 'je-new',
  }
  // The row the link wrote on F-2: dated on the credit note's verifikat.
  const setOff = {
    id: 'pay-setoff', invoice_id: 'new', journal_entry_id: 'je-cn', amount: 40000, currency: 'SEK',
    payment_exchange_rate: null, payment_date: '2026-09-10', invoice: { invoice_date: '2026-09-20' },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('live view: the credit used on the new invoice is no longer open, so the ledger matches 1510', async () => {
    tables = {
      invoices: [original, creditNote, newInvoice],
      invoice_payments: [setOff],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.total_outstanding).toBe(10000)
    expect(report.entries).toHaveLength(1)
    const rows = Object.fromEntries(report.entries[0].invoices.map((inv) => [inv.invoice_id, inv]))
    expect(rows.cn).toMatchObject({ total: -40000, outstanding: 0, outstanding_sek: 0, paid_amount: -40000 })
    expect(rows.new).toMatchObject({ outstanding: 10000 })
    expect(report.unpaid_count).toBe(1)
  })

  it('live view: a credit used only in part keeps its rest open', async () => {
    // The link cannot write this today (it refuses a credit larger than the
    // invoice's remaining); the rule reads the payment rows, whatever they
    // hold. A 25 000 invoice paid by the credit is not in the live population;
    // 15 000 of the credit is still the customer's.
    tables = {
      invoices: [original, creditNote],
      invoice_payments: [{ ...setOff, amount: 25000 }],
    }

    const report = await generateARLedger(supabase, 'company-1')

    const cn = report.entries[0].invoices.find((inv) => inv.invoice_id === 'cn')
    expect(cn?.outstanding).toBe(-15000)
    expect(report.total_outstanding).toBe(-15000)
  })

  it('live view: a verifikat linked to two invoices shows on the credit note and still matches 1510', async () => {
    // The link refuses a second link to the same invoice only. KR-F-1's
    // verifikat paid 40 000 on F-2 (50 000) and again on F-3 (60 000): 1510 is
    // 50 000 + 60 000 - 40 000 = 70 000. The credit note reads +40 000, the
    // credit used twice, so the anomaly sits on its row and the total ties out.
    const third = {
      ...newInvoice, id: 'third', invoice_number: 'F-3', invoice_date: '2026-09-25', due_date: '2026-10-25',
      total: 60000, paid_amount: 40000, remaining_amount: 20000, journal_entry_id: 'je-third',
    }
    tables = {
      invoices: [original, creditNote, newInvoice, third],
      invoice_payments: [
        setOff,
        { ...setOff, id: 'pay-setoff-2', invoice_id: 'third', invoice: { invoice_date: '2026-09-25' } },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    const rows = Object.fromEntries(report.entries[0].invoices.map((inv) => [inv.invoice_id, inv]))
    expect(rows.cn.outstanding).toBe(40000)
    expect(rows.new.outstanding).toBe(10000)
    expect(rows.third.outstanding).toBe(20000)
    expect(report.total_outstanding).toBe(70000)
  })

  it('as of a date before the new invoice existed, the credit is still open', async () => {
    tables = {
      // invoice_date <= 2026-09-15: the new invoice is not in the population yet.
      invoices: [original, creditNote, newInvoice],
      invoice_payments: [{ invoice_id: 'orig', amount: 40000, payment_date: '2026-09-05' }, setOff],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-09-15')

    expect(report.total_outstanding).toBe(-40000)
    const cn = report.entries[0].invoices.find((inv) => inv.invoice_id === 'cn')
    expect(cn?.outstanding).toBe(-40000)
  })

  it('as of a date after the set-off, the ledger matches 1510', async () => {
    tables = {
      invoices: [original, creditNote, newInvoice],
      invoice_payments: [{ invoice_id: 'orig', amount: 40000, payment_date: '2026-09-05' }, setOff],
    }

    const report = await generateARLedger(supabase, 'company-1', '2026-09-30')

    expect(report.total_outstanding).toBe(10000)
    const rows = Object.fromEntries(report.entries[0].invoices.map((inv) => [inv.invoice_id, inv]))
    expect(rows.cn.outstanding).toBe(0)
    expect(rows.new.outstanding).toBe(10000)
  })

  it('returns the empty report when the population, set-offs included, cannot be read', async () => {
    tables = { invoices: [original, creditNote, newInvoice], invoice_payments: [setOff] }
    failures = { get_ar_ledger_invoices: { message: 'boom' } }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })
})

describe('generateARLedger: ROT/RUT invoices awaiting Skatteverket', () => {
  // RUT invoice: 10 000 invoiced, deduction 3 000 on 1513, the buyer paid
  // their 7 000 on 2025-03-01. Skatteverket's 3 000 stays open on 1513 until
  // the begäran's payout voucher (dated 2025-05-10) clears it.
  const customer = { customer_id: 'cust-r', customer: { id: 'cust-r', name: 'Hushållet' } }
  const rut = {
    ...customer,
    id: 'inv-rut',
    invoice_number: 'F-RUT',
    invoice_date: '2025-02-01',
    due_date: '2025-03-01',
    total: 10000,
    paid_amount: 7000,
    paid_at: '2025-03-01T12:00:00Z',
    deduction_total: 3000,
    deduction_reclaimed_total: 0,
    currency: 'SEK',
    status: 'paid',
  }
  const plain = {
    ...customer,
    id: 'inv-plain',
    invoice_number: 'F-PLAIN',
    invoice_date: '2025-02-01',
    due_date: '2025-03-01',
    total: 1250,
    paid_amount: 0,
    deduction_total: 0,
    currency: 'SEK',
    status: 'sent',
  }
  // One begäran item for the invoice, on a begäran settled by the payout
  // voucher of 2025-05-10.
  const item = (status: string, decided: number | null): ReskontraTables => ({
    rot_rut_payout_request_items: [{ id: `item-${status}`, invoice_id: 'inv-rut', request_id: `req-${status}`, decided_amount: decided }],
    rot_rut_payout_requests: [{ id: `req-${status}`, status, settlement_journal_entry_id: 'je-payout' }],
    journal_entries: [{ id: 'je-payout', entry_date: '2025-05-10', status: 'posted' }],
  })
  const payment = { invoice_id: 'inv-rut', amount: 7000, payment_date: '2025-03-01' }
  const rows = (report: Awaited<ReturnType<typeof generateARLedger>>) =>
    Object.fromEntries(report.entries.flatMap((e) => e.invoices).map((i) => [i.invoice_id, i]))

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-09-01T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('live view reads paid invoices with a deduction into the population', async () => {
    // A paid invoice without a deduction is settled and not read live.
    tables = { invoices: [rut, { ...plain, id: 'inv-paid', status: 'paid', paid_amount: 1250 }] }

    const report = await generateARLedger(supabase, 'company-1')

    expect(Object.keys(rows(report))).toEqual(['inv-rut'])
  })

  it('live view lists a paid invoice whose begäran is not settled with the deduction outstanding', async () => {
    tables = {
      invoices: [rut, plain],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(rows(report)['inv-rut']).toMatchObject({ total: 10000, paid_amount: 7000, outstanding: 3000, outstanding_sek: 3000 })
    // The invoice without a deduction reads as it always did.
    expect(rows(report)['inv-plain']).toMatchObject({ total: 1250, paid_amount: 0, outstanding: 1250 })
    expect(report.total_outstanding).toBe(4250)
    expect(report.unpaid_count).toBe(2)
  })

  it('live view leaves out a paid invoice whose begäran is settled in full', async () => {
    tables = { invoices: [rut, plain], ...item('paid', 3000) }

    const report = await generateARLedger(supabase, 'company-1')

    expect(Object.keys(rows(report))).toEqual(['inv-plain'])
    expect(report.total_outstanding).toBe(1250)
    expect(report.unpaid_count).toBe(1)
  })

  it('live view keeps the refused remainder of a partly paid begäran', async () => {
    tables = { invoices: [rut], ...item('partially_paid', 2000) }

    const report = await generateARLedger(supabase, 'company-1')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 1000, paid_amount: 9000 })
    expect(report.total_outstanding).toBe(1000)
  })

  it('live view counts a reclaimed remainder once, as the buyer\'s again', async () => {
    // The refused 1 000 moved onto the buyer: partially_paid until they pay it.
    const reclaimed = { ...rut, deduction_reclaimed_total: 1000, status: 'partially_paid', paid_at: null }
    tables = { invoices: [reclaimed], ...item('partially_paid', 2000) }

    const report = await generateARLedger(supabase, 'company-1')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 1000 })
    expect(report.total_outstanding).toBe(1000)
  })

  it('live view leaves out a paid invoice whose reclaimed remainder the buyer has paid', async () => {
    const settled = { ...rut, paid_amount: 8000, deduction_reclaimed_total: 1000 }
    tables = { invoices: [settled], ...item('partially_paid', 2000) }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('historical view before the payout date keeps the deduction outstanding', async () => {
    tables = { invoices: [rut], invoice_payments: [payment], ...item('paid', 3000) }

    const report = await generateARLedger(supabase, 'company-1', '2025-05-09')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 3000, paid_amount: 7000 })
    expect(report.total_outstanding).toBe(3000)
  })

  it('historical view on the payout date leaves the invoice out', async () => {
    tables = { invoices: [rut], invoice_payments: [payment], ...item('paid', 3000) }

    const report = await generateARLedger(supabase, 'company-1', '2025-05-10')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('historical view before the buyer paid shows the whole invoice', async () => {
    tables = { invoices: [rut], invoice_payments: [payment], ...item('paid', 3000) }

    const report = await generateARLedger(supabase, 'company-1', '2025-02-15')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 10000, paid_amount: 0 })
  })
})

describe('generateARLedger: a credited invoice and its credit note read as a pair (crm#1537)', () => {
  const base = { customer_id: 'cust-a', customer: { id: 'cust-a', name: 'Test AB' }, paid_amount: 0, currency: 'SEK' }
  const open = { ...base, id: 'inv-open', invoice_number: 'F010', invoice_date: '2026-09-01', due_date: '2026-10-01', total: 500, status: 'sent' }
  const original = (total: number, extra: Record<string, unknown> = {}) => ({
    ...base, id: 'inv-orig', invoice_number: 'F001', invoice_date: '2026-06-01', due_date: '2026-07-01', total, status: 'credited', ...extra,
  })
  const creditNote = (total: number, extra: Record<string, unknown> = {}) => ({
    ...base, id: 'inv-kr', invoice_number: 'KR001', invoice_date: '2026-10-20', due_date: '2026-10-20', total, status: 'sent', credited_invoice_id: 'inv-orig', ...extra,
  })

  it('lists neither row of a full credit as open or overdue beside another open invoice, and keeps the totals', async () => {
    tables = { invoices: [original(1000), creditNote(-1000), open] }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toHaveLength(1)
    const entry = report.entries[0]
    expect(entry.invoices.map((inv) => inv.invoice_id)).toEqual(['inv-open'])
    // Only the open invoice ages: no 1 000 in an overdue bucket against -1 000 in current.
    expect(entry.days_1_30 + entry.days_31_60 + entry.days_61_90 + entry.days_90_plus).toBe(entry.total_outstanding - entry.current)
    expect(entry.total_outstanding).toBe(500)
    expect(report.total_outstanding).toBe(500)
    expect(report.unpaid_count).toBe(1)
  })

  it('keeps the rest of a partial credit on the original, aged by its own due date, and drops the used-up credit note', async () => {
    tables = { invoices: [original(1000), creditNote(-400)] }

    const report = await generateARLedger(supabase, 'company-1', '2026-10-25')

    const entry = report.entries[0]
    expect(entry.invoices).toHaveLength(1)
    expect(entry.invoices[0]).toMatchObject({ invoice_id: 'inv-orig', outstanding: 600, outstanding_sek: 600, paid_amount: 400 })
    expect(entry.invoices[0].days_overdue).toBeGreaterThan(90)
    expect(entry.days_90_plus).toBe(600)
    expect(entry.current).toBe(0)
    expect(report.total_outstanding).toBe(600)
  })

  it('leaves a credit above what the original still owes on the credit note, owed back', async () => {
    // Paid in full, then credited: nothing left on the original, the credit is owed back.
    tables = { invoices: [original(1000, { paid_amount: 1000 }), creditNote(-1000)] }

    const report = await generateARLedger(supabase, 'company-1')

    const entry = report.entries[0]
    expect(entry.invoices.map((inv) => [inv.invoice_id, inv.outstanding])).toEqual([['inv-kr', -1000]])
    expect(report.total_outstanding).toBe(-1000)
  })

  it('applies a credit only to the invoice it credits, in the same conversion', async () => {
    // A credit note for another invoice, and a foreign pair at different rates, stay unpaired.
    tables = {
      invoices: [
        original(1000),
        creditNote(-1000, { credited_invoice_id: 'inv-elsewhere' }),
        { ...original(100, { currency: 'EUR', exchange_rate: 11 }), id: 'inv-eur' },
        { ...creditNote(-100, { currency: 'EUR', exchange_rate: 11.5 }), id: 'kr-eur', credited_invoice_id: 'inv-eur' },
      ],
    }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries[0].invoices.map((inv) => inv.invoice_id).sort()).toEqual(['inv-eur', 'inv-kr', 'inv-orig', 'kr-eur'])
    expect(report.total_outstanding).toBe(roundSek(1000 - 1000 + 1100 - 1150))
  })

  it('lists the pair unpaired, with the same totals, when the link cannot be read', async () => {
    tables = { invoices: [original(1000), creditNote(-1000), open] }
    failures = { invoices: { message: 'read failed' } }

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries[0].invoices.map((inv) => inv.invoice_id).sort()).toEqual(['inv-kr', 'inv-open', 'inv-orig'])
    expect(report.total_outstanding).toBe(500)
  })
})

function roundSek(n: number): number {
  return Math.round(n * 100) / 100
}
