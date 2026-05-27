import { describe, it, expect, beforeEach, vi } from 'vitest'
import { detectPeriodisering } from '../auto-detect'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('detectPeriodisering', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
    vi.clearAllMocks()
  })

  it('returns empty array when the fiscal period is not found', async () => {
    mock.enqueue({ data: null, error: { message: 'not found' } })
    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toEqual([])
  })

  it('detects a supplier invoice that spans year-end and pro-rates the amount', async () => {
    // 1) fiscal_periods
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    // 2) invoices (none)
    mock.enqueue({ data: [], error: null })
    // 3) supplier_invoices — one 12-month annual license invoice
    //    Window: 2025-07-01 → 2026-06-30 = 365 days
    //    After period_end 2025-12-31: 2026-01-01 → 2026-06-30 = 181 days
    //    Subtotal 12000 → 12000 * 181/365 ≈ 5950.68 → 5950.68 rounded keeps 2 decimals
    mock.enqueue({
      data: [
        {
          id: 'sup-inv-1',
          supplier_invoice_number: 'LF-100',
          invoice_date: '2025-07-01',
          subtotal: 12000,
          notes: 'Mjukvarulicens period: 2025-07-01 till 2026-06-30',
          suppliers: { name: 'Acme SaaS AB' },
          supplier_invoice_items: [{ description: 'Årslicens', account_number: '5800' }],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toHaveLength(1)
    expect(result[0].source_type).toBe('supplier_invoice')
    expect(result[0].source_invoice_id).toBe('sup-inv-1')
    expect(result[0].parsed_start).toBe('2025-07-01')
    expect(result[0].parsed_end).toBe('2026-06-30')
    expect(result[0].confidence).toBe('high')
    // 12000 * 181/365 = 5950.6849... → 5950.68
    expect(result[0].periodisering_amount).toBeCloseTo(5950.68, 2)
    expect(result[0].suggested_prepaid_account).toBe('1710')
    expect(result[0].suggested_deferred_account).toBeNull()
  })

  it('detects a customer invoice with a service window in its notes', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    // Customer invoice for an annual subscription billed Dec 1 2025 covering
    // Jan 1 2026 → Dec 31 2026 entirely. Entire amount belongs to next year.
    mock.enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: 'F-2001',
          invoice_date: '2025-12-01',
          subtotal: 24000,
          notes: 'Årsabonnemang för period 2026-01-01 till 2026-12-31',
          customers: { name: 'Kund AB' },
          invoice_items: [{ description: 'Premium abonnemang' }],
        },
      ],
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // supplier_invoices

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toHaveLength(1)
    expect(result[0].source_type).toBe('invoice')
    expect(result[0].confidence).toBe('high')
    // Entire 24000 belongs to next year
    expect(result[0].periodisering_amount).toBe(24000)
    expect(result[0].suggested_deferred_account).toBe('2970')
    expect(result[0].suggested_prepaid_account).toBeNull()
  })

  it('downgrades confidence to "medium" when the date range comes from line items', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // invoices
    mock.enqueue({
      data: [
        {
          id: 'sup-inv-2',
          supplier_invoice_number: 'LF-200',
          invoice_date: '2025-12-15',
          subtotal: 6000,
          notes: 'Försäkringspremie', // no date range in head
          suppliers: { name: 'Försäkring AB' },
          supplier_invoice_items: [
            // Range only on the line item
            {
              description: 'Försäkring period 2026-01-01 till 2026-06-30',
              account_number: '6310',
            },
          ],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe('medium')
    expect(result[0].periodisering_amount).toBe(6000) // entire 6000 → next year
  })

  it('ignores invoices whose parsed range ends within the period', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // invoices
    mock.enqueue({
      data: [
        {
          id: 'sup-inv-3',
          supplier_invoice_number: 'LF-300',
          invoice_date: '2025-06-01',
          subtotal: 4000,
          notes: 'Hyra perioden 2025-06-01 till 2025-08-31',
          suppliers: { name: 'Hyresvärd AB' },
          supplier_invoice_items: [{ description: 'Hyra Q3', account_number: '5010' }],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toEqual([])
  })

  it('ignores invoices with no parseable date range', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({
      data: [
        {
          id: 'sup-inv-4',
          supplier_invoice_number: 'LF-400',
          invoice_date: '2025-12-30',
          subtotal: 5000,
          notes: 'Tack för köpet hos oss!',
          suppliers: { name: 'Random AB' },
          supplier_invoice_items: [{ description: 'Diverse', account_number: '6590' }],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toEqual([])
  })

  it('sorts suggestions by confidence (high first) then by amount desc', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null })
    mock.enqueue({
      data: [
        {
          id: 'sup-medium',
          supplier_invoice_number: 'LF-A',
          invoice_date: '2025-12-01',
          subtotal: 9000, // bigger, but medium confidence (range in line item)
          notes: 'Försäkring',
          suppliers: { name: 'A' },
          supplier_invoice_items: [
            {
              description: 'Period 2026-01-01 till 2026-12-31',
              account_number: '6310',
            },
          ],
        },
        {
          id: 'sup-high',
          supplier_invoice_number: 'LF-B',
          invoice_date: '2025-12-01',
          subtotal: 3000, // smaller, but high confidence
          notes: 'Mjukvara perioden 2026-01-01 till 2026-12-31',
          suppliers: { name: 'B' },
          supplier_invoice_items: [{ description: 'License', account_number: '5800' }],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
    )
    expect(result).toHaveLength(2)
    // high confidence wins over a larger medium-confidence suggestion
    expect(result[0].source_invoice_id).toBe('sup-high')
    expect(result[1].source_invoice_id).toBe('sup-medium')
  })
})
