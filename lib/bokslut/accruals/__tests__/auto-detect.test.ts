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
    // accrual_schedules: löpande periodiseringar that exclude their invoices
    mock.enqueue({ data: [], error: null })
    // 2) invoices (none)
    mock.enqueue({ data: [], error: null })
    // 3) supplier_invoices: one 12-month annual license invoice
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
    // accrual_schedules: löpande periodiseringar that exclude their invoices
    mock.enqueue({ data: [], error: null })
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
    // accrual_schedules: löpande periodiseringar that exclude their invoices
    mock.enqueue({ data: [], error: null })
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
    // accrual_schedules: löpande periodiseringar that exclude their invoices
    mock.enqueue({ data: [], error: null })
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
    // accrual_schedules: löpande periodiseringar that exclude their invoices
    mock.enqueue({ data: [], error: null })
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
    // accrual_schedules: löpande periodiseringar that exclude their invoices
    mock.enqueue({ data: [], error: null })
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
          // Smaller, but high confidence. Kept above the 5 000 kr materiality
          // floor so the floor's low-confidence downgrade doesn't apply here.
          subtotal: 6000,
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

  it('excludes invoices already covered by a löpande accrual schedule', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    // accrual_schedules: sup-inv-1 is already deferred line-by-line
    mock.enqueue({
      data: [{ supplier_invoice_id: 'sup-inv-1', invoice_id: null }],
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // invoices
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
    // Suggesting it again would periodisera the same belopp twice.
    expect(result).toEqual([])
  })

  it('tags a suggestion under 5 000 kr as low confidence citing K2 by default', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    // 1 200 kr domain renewal fully in next year: below the materiality floor.
    mock.enqueue({
      data: [
        {
          id: 'sup-small',
          supplier_invoice_number: 'LF-500',
          invoice_date: '2025-12-15',
          subtotal: 1200,
          currency: 'SEK',
          subtotal_sek: 1200,
          notes: 'Domänförnyelse period 2026-01-01 till 2026-12-31',
          suppliers: { name: 'Registrar AB' },
          supplier_invoice_items: [{ description: 'Domän', account_number: '6540' }],
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
    // Downgraded so the wizard does NOT pre-tick it (only 'high' is pre-ticked).
    expect(result[0].confidence).toBe('low')
    expect(result[0].reason).toContain('Under 5 000 kr: behöver normalt inte periodiseras (K2).')
  })

  it('cites K1 in the under-floor reason for an enskild firma', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    mock.enqueue({
      data: [
        {
          id: 'sup-small-ef',
          supplier_invoice_number: 'LF-501',
          invoice_date: '2025-12-15',
          subtotal: 1200,
          notes: 'Domänförnyelse period 2026-01-01 till 2026-12-31',
          suppliers: { name: 'Registrar AB' },
          supplier_invoice_items: [{ description: 'Domän', account_number: '6540' }],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
      { entityType: 'enskild_firma' },
    )
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe('low')
    expect(result[0].reason).toContain('Under 5 000 kr: behöver normalt inte periodiseras (K1).')
  })

  it('keeps a suggestion at or above 5 000 kr at its original confidence', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    mock.enqueue({
      data: [
        {
          id: 'sup-large',
          supplier_invoice_number: 'LF-502',
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
      { entityType: 'enskild_firma' },
    )
    expect(result).toHaveLength(1)
    // 12000 * 181/365 = 5950.68: above the floor, stays high with no K1 note.
    expect(result[0].confidence).toBe('high')
    expect(result[0].reason).not.toContain('Under 5 000 kr')
  })

  it('compares the floor against the SEK amount for a foreign-currency invoice', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    // 460 EUR is numerically under 5 000, but its SEK equivalent (5 200 kr)
    // is ABOVE the floor: comparing the raw EUR number would wrongly tag it.
    mock.enqueue({
      data: [
        {
          id: 'sup-eur',
          supplier_invoice_number: 'LF-510',
          invoice_date: '2025-12-15',
          subtotal: 460,
          currency: 'EUR',
          subtotal_sek: 5200,
          notes: 'SaaS-licens period 2026-01-01 till 2026-12-31',
          suppliers: { name: 'Euro SaaS GmbH' },
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
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe('high')
    expect(result[0].reason).not.toContain('Under 5 000 kr')
  })

  it('skips the floor entirely for a foreign-currency invoice without subtotal_sek', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    // No SEK amount is resolvable, so the floor must not tag on the raw EUR
    // number (wrong currency): the suggestion keeps its confidence.
    mock.enqueue({
      data: [
        {
          id: 'sup-eur-nosek',
          supplier_invoice_number: 'LF-511',
          invoice_date: '2025-12-15',
          subtotal: 120,
          currency: 'EUR',
          subtotal_sek: null,
          notes: 'SaaS-licens period 2026-01-01 till 2026-12-31',
          suppliers: { name: 'Euro SaaS GmbH' },
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
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe('high')
    expect(result[0].reason).not.toContain('Under 5 000 kr')
  })

  it('never applies the floor to personnel-cost (70xx-76xx) lines', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    // Personnel costs must ALWAYS be accrued regardless of amount, so a
    // 1 500 kr post on a 7xxx account keeps its confidence.
    mock.enqueue({
      data: [
        {
          id: 'sup-personnel',
          supplier_invoice_number: 'LF-503',
          invoice_date: '2025-12-15',
          subtotal: 1500,
          notes: 'Utbildning personal period 2026-01-01 till 2026-03-31',
          suppliers: { name: 'Kursbolaget AB' },
          supplier_invoice_items: [{ description: 'Kurs', account_number: '7610' }],
        },
      ],
      error: null,
    })

    const result = await detectPeriodisering(
      mock.supabase as never,
      'company-1',
      'period-1',
      { entityType: 'enskild_firma' },
    )
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe('high')
    expect(result[0].reason).not.toContain('Under 5 000 kr')
  })

  it('applies the floor to a 79xx line: not a personnel cost', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({ data: [], error: null }) // invoices
    // 7990 (övriga rörelsekostnader) is in the 7xxx class but is NOT a
    // personnel cost: the exemption is BAS 70xx-76xx only, so a small 7990
    // post gets the normal under-floor downgrade.
    mock.enqueue({
      data: [
        {
          id: 'sup-7990',
          supplier_invoice_number: 'LF-504',
          invoice_date: '2025-12-15',
          subtotal: 1500,
          notes: 'Diverse kostnad period 2026-01-01 till 2026-03-31',
          suppliers: { name: 'Diverse AB' },
          supplier_invoice_items: [{ description: 'Övrigt', account_number: '7990' }],
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
    expect(result[0].confidence).toBe('low')
    expect(result[0].reason).toContain('Under 5 000 kr')
  })

  it('applies the floor to a small customer-invoice revenue deferral', async () => {
    mock.enqueue({
      data: { id: 'period-1', period_start: '2025-01-01', period_end: '2025-12-31' },
      error: null,
    })
    mock.enqueue({ data: [], error: null }) // accrual_schedules
    mock.enqueue({
      data: [
        {
          id: 'inv-small',
          invoice_number: 'F-3001',
          invoice_date: '2025-12-01',
          subtotal: 2400,
          notes: 'Supportavtal för period 2026-01-01 till 2026-12-31',
          customers: { name: 'Kund AB' },
          invoice_items: [{ description: 'Support' }],
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
    expect(result[0].confidence).toBe('low')
    expect(result[0].reason).toContain('Under 5 000 kr')
  })
})
