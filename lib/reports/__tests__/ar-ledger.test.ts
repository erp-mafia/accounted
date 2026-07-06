import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock: sequential result queue
// ============================================================

let resultIdx: number
let results: Array<{ data?: unknown; error?: unknown }>

function makeBuilder() {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
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
  supabase = makeClient()
})

describe('generateARLedger', () => {
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
