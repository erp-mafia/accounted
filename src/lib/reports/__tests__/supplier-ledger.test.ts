import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createReskontraClient, type ReskontraTables } from '@/tests/reskontra-rpc-port'
import { generateSupplierLedger } from '../supplier-ledger'

// ============================================================
// The ledger reads its population with get_supplier_ledger_invoices,
// answered from `tables` by its JS port (tests/reskontra-rpc-port.ts).
// ============================================================

let tables: ReskontraTables
let failures: Record<string, { message: string }>
const { supabase, calls } = createReskontraClient(() => tables, () => failures)

/**
 * The books; an invoice without an id, a status or an invoice date is an
 * approved one dated 2024-01-01.
 */
function setBooks(books: ReskontraTables) {
  tables = {
    ...books,
    supplier_invoices: (books.supplier_invoices ?? []).map((row, i) => ({
      id: `si-${i + 1}`,
      status: 'approved',
      invoice_date: '2024-01-01',
      ...row,
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  tables = {}
  failures = {}
})

describe('generateSupplierLedger', () => {
  it('returns empty report when no invoices found', async () => {
    setBooks({ supplier_invoices: [] })

    const report = await generateSupplierLedger(supabase, 'company-1')
    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
    expect(report.total_current).toBe(0)
    expect(report.total_overdue).toBe(0)
    expect(report.unpaid_count).toBe(0)
  })

  it('returns empty report on query error', async () => {
    failures = { get_supplier_ledger_invoices: { message: 'DB error' } }

    const report = await generateSupplierLedger(supabase, 'company-1')
    expect(report.entries).toEqual([])
    expect(report.total_outstanding).toBe(0)
  })

  it('places invoices in correct aging buckets', async () => {
    // Reference date: 2024-06-15
    const asOfDate = '2024-06-15'

    setBooks({ supplier_invoices: [
        // Current: due in the future (days overdue <= 0)
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Leverantör A' },
          due_date: '2024-06-20',
          remaining_amount: 5000,
        },
        // 1-30 days overdue: due_date 2024-06-01 (14 days overdue)
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Leverantör A' },
          due_date: '2024-06-01',
          remaining_amount: 3000,
        },
        // 31-60 days overdue: due_date 2024-05-01 (45 days overdue)
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Leverantör A' },
          due_date: '2024-05-01',
          remaining_amount: 2000,
        },
        // 61-90 days overdue: due_date 2024-04-01 (75 days overdue)
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Leverantör A' },
          due_date: '2024-04-01',
          remaining_amount: 1500,
        },
        // 90+ days overdue: due_date 2024-02-01 (135 days overdue)
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Leverantör A' },
          due_date: '2024-02-01',
          remaining_amount: 1000,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', asOfDate)

    expect(report.entries).toHaveLength(1)
    const entry = report.entries[0]
    expect(entry.current).toBe(5000)
    expect(entry.days_1_30).toBe(3000)
    expect(entry.days_31_60).toBe(2000)
    expect(entry.days_61_90).toBe(1500)
    expect(entry.days_90_plus).toBe(1000)
    expect(entry.total_outstanding).toBe(12500)
  })

  it('groups by supplier and uses fallback name for missing supplier', async () => {
    setBooks({ supplier_invoices: [
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Leverantör A' },
          due_date: '2024-07-01',
          remaining_amount: 5000,
        },
        {
          supplier_id: 'sup-2',
          supplier: null,
          due_date: '2024-07-01',
          remaining_amount: 3000,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(2)
    const names = report.entries.map(e => e.supplier_name)
    expect(names).toContain('Leverantör A')
    expect(names).toContain('Okänd leverantör')
  })

  it('sorts entries by outstanding descending', async () => {
    setBooks({ supplier_invoices: [
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Small' },
          due_date: '2024-07-01',
          remaining_amount: 1000,
        },
        {
          supplier_id: 'sup-2',
          supplier: { id: 'sup-2', name: 'Large' },
          due_date: '2024-07-01',
          remaining_amount: 10000,
        },
        {
          supplier_id: 'sup-3',
          supplier: { id: 'sup-3', name: 'Medium' },
          due_date: '2024-07-01',
          remaining_amount: 5000,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries[0].supplier_name).toBe('Large')
    expect(report.entries[1].supplier_name).toBe('Medium')
    expect(report.entries[2].supplier_name).toBe('Small')
  })

  it('calculates grand totals correctly', async () => {
    setBooks({ supplier_invoices: [
        // Supplier A: current 5000
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'A' },
          due_date: '2024-07-01',
          remaining_amount: 5000,
        },
        // Supplier B: 1-30 days overdue 3000
        {
          supplier_id: 'sup-2',
          supplier: { id: 'sup-2', name: 'B' },
          due_date: '2024-06-01',
          remaining_amount: 3000,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.total_outstanding).toBe(8000)
    expect(report.total_current).toBe(5000)
    expect(report.total_overdue).toBe(3000) // outstanding - current
    expect(report.unpaid_count).toBe(2)
  })

  it('converts foreign-currency invoices to SEK using exchange_rate', async () => {
    // Reproduces the production bug: EUR/USD invoices were summed as if SEK,
    // making the ledger total drift from the 2440 GL balance.
    setBooks({ supplier_invoices: [
        // 225 EUR at 11.00 → 2 475 SEK
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Anthropic' },
          due_date: '2024-06-01',
          remaining_amount: 225,
          currency: 'EUR',
          exchange_rate: 11,
        },
        // 6.25 USD at 10.00 → 62.50 SEK
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Anthropic' },
          due_date: '2024-06-01',
          remaining_amount: 6.25,
          currency: 'USD',
          exchange_rate: 10,
        },
        // 1 000 SEK (no conversion)
        {
          supplier_id: 'sup-2',
          supplier: { id: 'sup-2', name: 'Svensk leverantör' },
          due_date: '2024-06-01',
          remaining_amount: 1000,
          currency: 'SEK',
          exchange_rate: null,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    // Anthropic: 2 475 + 62.50 = 2 537.50 SEK (all in 1-30 days bucket)
    const anthropic = report.entries.find(e => e.supplier_name === 'Anthropic')!
    expect(anthropic.days_1_30).toBe(2537.5)
    expect(anthropic.total_outstanding).toBe(2537.5)

    // Swedish supplier unchanged
    const swedish = report.entries.find(e => e.supplier_name === 'Svensk leverantör')!
    expect(swedish.days_1_30).toBe(1000)

    // Grand total in SEK: 2 537.50 + 1 000 = 3 537.50
    expect(report.total_outstanding).toBe(3537.5)
  })

  it('excludes FX invoices without exchange_rate from totals and counts them', async () => {
    // Legacy data: an FX invoice without an exchange rate cannot be converted
    // to SEK without falsifying the total. The row is excluded from sums and
    // surfaced via unconverted_fx_count so the UI can warn the user.
    setBooks({ supplier_invoices: [
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Legacy' },
          due_date: '2024-06-01',
          remaining_amount: 100,
          currency: 'EUR',
          exchange_rate: null,
        },
        {
          supplier_id: 'sup-2',
          supplier: { id: 'sup-2', name: 'SEK supplier' },
          due_date: '2024-06-01',
          remaining_amount: 500,
          currency: 'SEK',
          exchange_rate: null,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')
    expect(report.total_outstanding).toBe(500)
    expect(report.unconverted_fx_count).toBe(1)
    expect(report.entries.map(e => e.supplier_name)).toEqual(['SEK supplier'])
  })

  it('uses Math.round for monetary precision', async () => {
    setBooks({ supplier_invoices: [
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Test' },
          due_date: '2024-07-01',
          remaining_amount: 33.33,
        },
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Test' },
          due_date: '2024-07-02',
          remaining_amount: 33.33,
        },
        {
          supplier_id: 'sup-1',
          supplier: { id: 'sup-1', name: 'Test' },
          due_date: '2024-07-03',
          remaining_amount: 33.34,
        },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.total_outstanding).toBe(100)
    expect(report.total_current).toBe(100)
  })
})

describe('generateSupplierLedger: historical as-of reconstruction (#1021)', () => {
  const invoiceBase = {
    supplier_id: 'sup-1',
    supplier: { id: 'sup-1', name: 'Leverantören AB' },
    invoice_date: '2024-05-01',
    due_date: '2024-06-01',
    currency: 'SEK',
  }

  it('reopens an invoice whose payment came after the as-of date', async () => {
    setBooks({
      supplier_invoices: [
        { ...invoiceBase, id: 'si-1', total: 8000, paid_amount: 8000, remaining_amount: 0, paid_at: '2024-07-01T10:00:00Z', status: 'paid' },
      ],
      supplier_invoice_payments: [{ supplier_invoice_id: 'si-1', amount: 8000, payment_date: '2024-07-01' }],
    })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].total_outstanding).toBe(8000)
    expect(report.total_outstanding).toBe(8000)
    expect(report.unpaid_count).toBe(1)
  })

  it('reduces outstanding by payments on or before the as-of date and skips settled invoices', async () => {
    setBooks({
      supplier_invoices: [
        // Partially paid at the as-of date: 4 000 of 10 000 paid.
        { ...invoiceBase, id: 'si-1', total: 10000, paid_amount: 10000, remaining_amount: 0, paid_at: '2024-07-05T10:00:00Z', status: 'paid' },
        // Fully settled before the as-of date: must not appear.
        { ...invoiceBase, id: 'si-2', total: 500, paid_amount: 500, remaining_amount: 0, paid_at: '2024-06-01T10:00:00Z', status: 'paid' },
      ],
      supplier_invoice_payments: [
        { supplier_invoice_id: 'si-1', amount: 4000, payment_date: '2024-06-10' },
        { supplier_invoice_id: 'si-1', amount: 6000, payment_date: '2024-07-05' },
      ],
    })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.total_outstanding).toBe(6000)
    expect(report.unpaid_count).toBe(1)
  })

  it('falls back to paid_at for fully paid invoices without payment rows', async () => {
    setBooks({
      supplier_invoices: [
        { ...invoiceBase, id: 'si-1', total: 3000, paid_amount: 3000, remaining_amount: 0, paid_at: '2024-08-01T10:00:00Z', status: 'paid' },
      ],
      supplier_invoice_payments: [],
    })

    const report = await generateSupplierLedger(supabase, 'company-1', '2024-06-15')

    expect(report.entries).toHaveLength(1)
    expect(report.total_outstanding).toBe(3000)
  })

  it('keeps the live remaining_amount for the live (non-backdated) view', async () => {
    // No asOfDate: the live population, stored remaining_amount trusted as-is.
    setBooks({ supplier_invoices: [
        { ...invoiceBase, id: 'si-1', total: 3000, paid_amount: 1000, remaining_amount: 2000, status: 'partially_paid' },
      ] })

    const report = await generateSupplierLedger(supabase, 'company-1')

    expect(calls.find((c) => c.name === 'get_supplier_ledger_invoices')?.args).toEqual({
      p_company_id: 'company-1',
      p_as_of_date: null,
      p_supplier_id: null,
    })
    expect(report.total_outstanding).toBe(2000)
    expect(report.unpaid_count).toBe(1)
  })
})
