import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>
let calls: Array<{ method: string; args: unknown[] }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'or', 'not', 'lte', 'order', 'range']) {
    b[m] = vi.fn().mockImplementation((...args: unknown[]) => {
      calls.push({ method: m, args })
      return b
    })
  }
  b.single = vi.fn().mockImplementation(async () => results[resultIdx++] ?? { data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve(results[resultIdx++] ?? { data: null, error: null })
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation(() => makeBuilder()),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateARLedger } from '../ar-ledger'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  resultIdx = 0
  results = []
  calls = []
  supabase = makeClient()
})

describe('generateARLedger', () => {
  it('only reads fakturor: proformas, delivery notes and quotes are not receivables', async () => {
    results = [{ data: [], error: null }]

    await generateARLedger(supabase, 'company-1')

    expect(calls).toContainEqual({ method: 'eq', args: ['document_type', 'invoice'] })
  })

  it('returns empty report when no invoices found', async () => {
    results = [
      { data: [], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')
    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
    expect(report.unpaid_count).toBe(0)
  })

  it('returns empty report on query error', async () => {
    results = [
      { data: null, error: { message: 'DB error' } },
    ]

    const report = await generateARLedger(supabase, 'company-1')
    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('groups invoices by customer with correct aging buckets', async () => {
    // Reference date: 2024-06-15
    const asOfDate = '2024-06-15'

    results = [
      {
        data: [
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
        error: null,
      },
    ]

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
    results = [
      {
        data: [
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
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries[0].invoices[0].outstanding).toBe(2500)
    expect(report.total_outstanding).toBe(2500)
  })

  it('sorts invoices within customer by due_date', async () => {
    results = [
      {
        data: [
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
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-05-15')

    // Sorted by due_date: F001 (June 1) before F002 (July 1)
    expect(report.entries[0].invoices[0].invoice_number).toBe('F001')
    expect(report.entries[0].invoices[1].invoice_number).toBe('F002')
  })

  it('aggregates foreign-currency invoices into SEK aging buckets but preserves original currency on detail rows', async () => {
    // The aging totals reconcile against account 1510 (SEK), but the per-invoice
    // detail row keeps `outstanding` in invoice currency for display.
    results = [
      {
        data: [
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
        error: null,
      },
    ]

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
    results = [
      {
        data: [
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
        error: null,
      },
    ]

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
    results = [
      {
        data: [
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
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')
    expect(report.entries[0].invoices[0].outstanding).toBe(66.77)
    expect(report.total_outstanding).toBe(66.77)
  })

  it('nets a credited invoice with its credit note to zero outstanding', async () => {
    // Original was sent (unpaid) and then fully credited.
    // Journal-level AR is 0; the ledger should match.
    results = [
      {
        data: [
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
        error: null,
      },
    ]

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
    results = [
      {
        data: [
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
        error: null,
      },
    ]

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
    results = [
      {
        data: [
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
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

    expect(report.entries.map((e) => e.customer_name)).toEqual(['Foreign Only AB'])
    expect(report.unconverted_fx_count).toBe(1)
    expect(report.total_outstanding).toBe(0)
  })

  it('keeps a credit note outstanding when it offsets an already-paid invoice', async () => {
    // Original was paid in full, then credited: we owe the customer the refund.
    results = [
      {
        data: [
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
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2026-05-05')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].total_outstanding).toBe(-1000)
    expect(report.total_outstanding).toBe(-1000)
    expect(report.unpaid_count).toBe(1)
  })

  it('handles missing customer name gracefully', async () => {
    results = [
      {
        data: [
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
        error: null,
      },
    ]

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
    results = [
      // Query 1: invoices (historical path also fetches status='paid')
      {
        data: [
          { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 5000, paid_amount: 5000, paid_at: '2024-07-01T10:00:00Z', status: 'paid' },
        ],
        error: null,
      },
      // Query 2: payment rows: the payment is dated after the as-of date
      {
        data: [{ invoice_id: 'inv-1', amount: 5000, payment_date: '2024-07-01' }],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].invoices[0].outstanding).toBe(5000)
    expect(report.entries[0].invoices[0].paid_amount).toBe(0)
    expect(report.total_outstanding).toBe(5000)
    expect(report.unpaid_count).toBe(1)
  })

  it('reduces outstanding by payments made on or before the as-of date only', async () => {
    results = [
      {
        data: [
          { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 10000, paid_amount: 10000, paid_at: '2024-07-05T10:00:00Z', status: 'paid' },
        ],
        error: null,
      },
      {
        data: [
          { invoice_id: 'inv-1', amount: 4000, payment_date: '2024-06-10' },
          { invoice_id: 'inv-1', amount: 6000, payment_date: '2024-07-05' },
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries[0].invoices[0].paid_amount).toBe(4000)
    expect(report.entries[0].invoices[0].outstanding).toBe(6000)
    expect(report.total_outstanding).toBe(6000)
  })

  it('keeps an invoice written off after the as-of date, and drops one written off by then', async () => {
    results = [
      {
        data: [
          // Konstaterad on or before the as-of date: off 1510 by then.
          { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 5000, paid_amount: 0, status: 'written_off' },
          // Konstaterad after the as-of date: still an open claim on the day.
          { ...invoiceBase, id: 'inv-2', invoice_number: 'F002', total: 3000, paid_amount: 1000, status: 'written_off' },
          // Konstaterad and annulled (storno) before the as-of date: open.
          { ...invoiceBase, id: 'inv-3', invoice_number: 'F003', total: 2000, paid_amount: 0, status: 'written_off' },
        ],
        error: null,
      },
      { data: [{ invoice_id: 'inv-2', amount: 1000, payment_date: '2024-06-01' }], error: null },
      // Kundförlust decisions dated on or before the as-of date.
      {
        data: [
          { id: 'w-1', invoice_id: 'inv-1', kind: 'confirmed', reverses_id: null },
          { id: 'w-3', invoice_id: 'inv-3', kind: 'confirmed', reverses_id: null },
          { id: 'w-4', invoice_id: 'inv-3', kind: 'annulled', reverses_id: 'w-3' },
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(calls.some((c) => c.method === 'in' && (c.args[1] as string[]).includes('written_off'))).toBe(true)
    const ids = report.entries.flatMap((e) => e.invoices.map((i) => i.invoice_number))
    expect(ids.sort()).toEqual(['F002', 'F003'])
    expect(report.total_outstanding).toBe(4000)
  })

  it('skips invoices already settled by the as-of date', async () => {
    results = [
      {
        data: [
          // Settled before the as-of date: must not appear at all.
          { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 1000, paid_amount: 1000, paid_at: '2024-06-01T10:00:00Z', status: 'paid' },
          // Still open: the only row in the report.
          { ...invoiceBase, id: 'inv-2', invoice_number: 'F002', total: 2000, paid_amount: 0, status: 'sent' },
        ],
        error: null,
      },
      { data: [], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].invoices).toHaveLength(1)
    expect(report.entries[0].invoices[0].invoice_number).toBe('F002')
    expect(report.total_outstanding).toBe(2000)
    expect(report.unpaid_count).toBe(1)
  })

  it('falls back to paid_at for fully paid invoices without payment rows', async () => {
    results = [
      {
        data: [
          // No payment rows, but paid_at says the payment came after the
          // as-of date: the invoice was open on that date.
          { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 3000, paid_amount: 3000, paid_at: '2024-08-01T10:00:00Z', status: 'paid' },
        ],
        error: null,
      },
      { data: [], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].invoices[0].outstanding).toBe(3000)
    expect(report.total_outstanding).toBe(3000)
  })

  it('keeps stored paid_amount for undateable legacy partial payments', async () => {
    results = [
      {
        data: [
          // No payment rows and no paid_at: the stored partial amount cannot
          // be dated, so it is assumed to have stood at the as-of date.
          { ...invoiceBase, id: 'inv-1', invoice_number: 'F001', total: 3000, paid_amount: 1000, status: 'sent' },
        ],
        error: null,
      },
      { data: [], error: null },
    ]

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

  // The first status filter recorded is the invoices query.
  const invoiceStatusFilter = () =>
    calls.find((c) => c.method === 'in' && c.args[0] === 'status')?.args[1]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('live view lists it with the unpaid remainder outstanding', async () => {
    results = [{ data: [partiallyPaid], error: null }]

    const report = await generateARLedger(supabase, 'company-1')

    // The live population is filtered with .or() (paid invoices awaiting
    // Skatteverket join the open ones).
    expect(calls.find((c) => c.method === 'or')?.args[0]).toContain('partially_paid')
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
    results = [
      { data: [partiallyPaid], error: null },
      { data: [payment], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2026-06-30')

    expect(invoiceStatusFilter()).toEqual(expect.arrayContaining(['partially_paid', 'paid']))
    expect(report.entries[0].invoices[0].paid_amount).toBe(0)
    expect(report.entries[0].invoices[0].outstanding).toBe(15625)
    expect(report.total_outstanding).toBe(15625)
  })

  it('historical view on or after the payment date shows the remainder', async () => {
    results = [
      { data: [partiallyPaid], error: null },
      { data: [payment], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2026-07-01')

    expect(invoiceStatusFilter()).toContain('partially_paid')
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
    results = [{ data: [migratedCreditNote('6', -11615)], error: null }]

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
    expect(report.unpaid_count).toBe(0)
  })

  it('leaves out a linked credit note whose original is credited and fully paid', async () => {
    results = [
      {
        data: [
          { ...base, id: 'orig', invoice_number: '10', total: 5000, paid_amount: 5000, status: 'credited' },
          migratedCreditNote('cn', -5000, 'orig'),
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('counts a partial credit once: the provider netted it into the original', async () => {
    // Faktura 9 694, krediterad med 4 847 i källsystemet: the original arrives
    // with paid_amount 4 847 carrying the credit, so 4 847 is still owed.
    results = [
      {
        data: [
          { ...base, id: 'orig', invoice_number: '5922', total: 9694, paid_amount: 4847, status: 'sent' },
          migratedCreditNote('cn', -4847, 'orig'),
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.total_outstanding).toBe(4847)
    expect(report.entries[0].invoices.map((inv) => inv.invoice_id)).toEqual(['orig'])
  })

  it('keeps the open invoices of the same customer', async () => {
    results = [
      {
        data: [
          { ...base, id: 'open', invoice_number: '12', total: 1000, paid_amount: 0, status: 'sent' },
          migratedCreditNote('cn', -11615),
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.total_outstanding).toBe(1000)
    expect(report.entries[0].invoices.map((inv) => inv.invoice_id)).toEqual(['open'])
  })

  it('does not touch an in-app credit note, which is issued as sent', async () => {
    results = [
      {
        data: [
          { ...base, id: 'orig', invoice_number: '13', total: 1000, paid_amount: 1000, status: 'credited' },
          { ...base, id: 'cn', invoice_number: '14', total: -1000, paid_amount: 0, status: 'sent', credited_invoice_id: 'orig' },
        ],
        error: null,
      },
    ]

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
    results = [
      { data: [original, creditNote, newInvoice], error: null },
      { data: [setOff], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(calls).toContainEqual({ method: 'in', args: ['journal_entry_id', ['je-cn']] })
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
    results = [
      { data: [original, creditNote], error: null },
      { data: [{ ...setOff, amount: 25000 }], error: null },
    ]

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
    results = [
      { data: [original, creditNote, newInvoice, third], error: null },
      {
        data: [
          setOff,
          { ...setOff, id: 'pay-setoff-2', invoice_id: 'third', invoice: { invoice_date: '2026-09-25' } },
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    const rows = Object.fromEntries(report.entries[0].invoices.map((inv) => [inv.invoice_id, inv]))
    expect(rows.cn.outstanding).toBe(40000)
    expect(rows.new.outstanding).toBe(10000)
    expect(rows.third.outstanding).toBe(20000)
    expect(report.total_outstanding).toBe(70000)
  })

  it('as of a date before the new invoice existed, the credit is still open', async () => {
    results = [
      // invoice_date <= 2026-09-15: the new invoice is not in the population yet.
      { data: [original, creditNote], error: null },
      { data: [setOff], error: null },
      {
        data: [
          { invoice_id: 'orig', amount: 40000, payment_date: '2026-09-05' },
          { invoice_id: 'new', amount: 40000, payment_date: '2026-09-10' },
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2026-09-15')

    expect(report.total_outstanding).toBe(-40000)
    const cn = report.entries[0].invoices.find((inv) => inv.invoice_id === 'cn')
    expect(cn?.outstanding).toBe(-40000)
  })

  it('as of a date after the set-off, the ledger matches 1510', async () => {
    results = [
      { data: [original, creditNote, newInvoice], error: null },
      { data: [setOff], error: null },
      {
        data: [
          { invoice_id: 'orig', amount: 40000, payment_date: '2026-09-05' },
          { invoice_id: 'new', amount: 40000, payment_date: '2026-09-10' },
        ],
        error: null,
      },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2026-09-30')

    expect(report.total_outstanding).toBe(10000)
    const rows = Object.fromEntries(report.entries[0].invoices.map((inv) => [inv.invoice_id, inv]))
    expect(rows.cn.outstanding).toBe(0)
    expect(rows.new.outstanding).toBe(10000)
  })

  it('returns the empty report when the set-off rows cannot be read, like any other failed read', async () => {
    results = [
      { data: [original, creditNote, newInvoice], error: null },
      { data: null, error: { message: 'boom' } },
    ]

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
  const item = (status: string, decided: number | null) => ({
    id: `item-${status}`,
    invoice_id: 'inv-rut',
    decided_amount: decided,
    request: { status, settlement: { entry_date: '2025-05-10' } },
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
    results = [{ data: [], error: null }]

    await generateARLedger(supabase, 'company-1')

    expect(calls.find((c) => c.method === 'or')?.args[0]).toBe(
      'status.in.(sent,overdue,partially_paid,credited),and(status.eq.paid,deduction_total.gt.0)'
    )
  })

  it('live view lists a paid invoice whose begäran is not settled with the deduction outstanding', async () => {
    results = [
      { data: [rut, plain], error: null },
      // No settled begäran item.
      { data: [], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(calls).toContainEqual({ method: 'in', args: ['invoice_id', ['inv-rut']] })
    expect(rows(report)['inv-rut']).toMatchObject({ total: 10000, paid_amount: 7000, outstanding: 3000, outstanding_sek: 3000 })
    // The invoice without a deduction reads as it always did.
    expect(rows(report)['inv-plain']).toMatchObject({ total: 1250, paid_amount: 0, outstanding: 1250 })
    expect(report.total_outstanding).toBe(4250)
    expect(report.unpaid_count).toBe(2)
  })

  it('live view leaves out a paid invoice whose begäran is settled in full', async () => {
    results = [
      { data: [rut, plain], error: null },
      { data: [item('paid', 3000)], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(Object.keys(rows(report))).toEqual(['inv-plain'])
    expect(report.total_outstanding).toBe(1250)
    expect(report.unpaid_count).toBe(1)
  })

  it('live view keeps the refused remainder of a partly paid begäran', async () => {
    results = [
      { data: [rut], error: null },
      { data: [item('partially_paid', 2000)], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 1000, paid_amount: 9000 })
    expect(report.total_outstanding).toBe(1000)
  })

  it('live view counts a reclaimed remainder once, as the buyer\'s again', async () => {
    // The refused 1 000 moved onto the buyer: partially_paid until they pay it.
    const reclaimed = { ...rut, deduction_reclaimed_total: 1000, status: 'partially_paid', paid_at: null }
    results = [
      { data: [reclaimed], error: null },
      { data: [item('partially_paid', 2000)], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 1000 })
    expect(report.total_outstanding).toBe(1000)
  })

  it('live view leaves out a paid invoice whose reclaimed remainder the buyer has paid', async () => {
    const settled = { ...rut, paid_amount: 8000, deduction_reclaimed_total: 1000 }
    results = [
      { data: [settled], error: null },
      { data: [item('partially_paid', 2000)], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('historical view before the payout date keeps the deduction outstanding', async () => {
    results = [
      { data: [rut], error: null },
      { data: [item('paid', 3000)], error: null },
      { data: [payment], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2025-05-09')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 3000, paid_amount: 7000 })
    expect(report.total_outstanding).toBe(3000)
  })

  it('historical view on the payout date leaves the invoice out', async () => {
    results = [
      { data: [rut], error: null },
      { data: [item('paid', 3000)], error: null },
      { data: [payment], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2025-05-10')

    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('historical view before the buyer paid shows the whole invoice', async () => {
    results = [
      { data: [rut], error: null },
      { data: [item('paid', 3000)], error: null },
      { data: [payment], error: null },
    ]

    const report = await generateARLedger(supabase, 'company-1', '2025-02-15')

    expect(rows(report)['inv-rut']).toMatchObject({ outstanding: 10000, paid_amount: 0 })
  })
})
