/**
 * Focused tests for computeVatReport: the shared VAT computation used by
 * gnubok_get_vat_report and gnubok_vat_review_widget. These exist because the
 * tools/call integration tests can't reach into the rutor math; this file
 * mocks Supabase to feed synthetic journal entry lines and asserts the rutor
 * shape, ruta48 inclusion of 2647, ruta49 formula, and the one-sided
 * reverse-charge warning.
 */
import { describe, it, expect } from 'vitest'
import { computeVatReport, tools } from '../server'

interface MockLine {
  account_number: string
  debit_amount: number
  credit_amount: number
}

function mockSupabaseWithLines(lines: MockLine[]) {
  // Build a chain that matches the call path in computeVatReport:
  //   .from('journal_entry_lines').select(...).eq(...).in(...).gte(...).lte(...).range(from, to)
  // computeVatReport now paginates via fetchAllRows, so the terminal call is
  // `.range(from, to)`. Returning all lines on the first page (always < the
  // 1000-row PAGE_SIZE for these fixtures) makes fetchAllRows stop after one page.
  const terminal = { data: lines, error: null }
  const chain: Record<string, () => unknown> = {}
  chain.range = () => terminal
  chain.lte = () => chain
  chain.gte = () => chain
  chain.in = () => chain
  chain.eq = () => chain
  chain.select = () => chain
  chain.from = () => chain
  return { from: chain.from } as never
}

describe('computeVatReport', () => {
  it('aggregates 2611 → ruta10, 2641 → ruta48, includes 2647 → ruta48', async () => {
    const lines: MockLine[] = [
      // Domestic 25% sale: 1000 + 250 VAT
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 250 },
      // Domestic input VAT 25%
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      // Domestic reverse-charge input VAT (2647)
      { account_number: '2647', debit_amount: 50, credit_amount: 0 },
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(1000)
    expect(result.rutor.ruta10).toBe(250)
    expect(result.rutor.ruta11).toBe(0)
    expect(result.rutor.ruta12).toBe(0)
    // Ruta 48 = 2641 (100) + 2647 (50) = 150
    expect(result.rutor.ruta48).toBe(150)
    // Ruta 49 = 250 - 150 = 100 (positive = pay)
    expect(result.rutor.ruta49).toBe(100)
    expect(result.summary).toContain('Moms att betala')
    expect(result.warnings).toEqual([])
  })

  it('aggregates reverse-charge output VAT into ruta30/31/32 and the ruta49 formula', async () => {
    const lines: MockLine[] = [
      // Reverse-charge purchase 25%: both sides booked correctly
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },  // ruta30
      { account_number: '2645', debit_amount: 500, credit_amount: 0 },  // matching input → ruta48
      // Reverse-charge purchase 6%
      { account_number: '2634', debit_amount: 0, credit_amount: 30 },   // ruta32
      { account_number: '2645', debit_amount: 30, credit_amount: 0 },
    ]

    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta31).toBe(0)
    expect(result.rutor.ruta32).toBe(30)
    expect(result.rutor.ruta48).toBe(530) // 500 + 30 from 2645
    // Ruta 49 = (10+11+12+30+31+32) - 48 = 0+0+0+500+0+30 - 530 = 0
    expect(result.rutor.ruta49).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('emits a one-sided-reverse-charge warning when 2614 is booked without 2645 OR 2647', async () => {
    const lines: MockLine[] = [
      // Output booked but matching input missing (the most common reverse-charge error)
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },
      // Neither 2645 nor 2647 present
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta48).toBe(0)
    // Without the matching input, ruta49 is inflated by 500: the warning surfaces this.
    expect(result.rutor.ruta49).toBe(500)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/Omvänd betalningsskyldighet/)
    // Both 2645 (EU) and 2647 (domestic) are mentioned so users know what to look for.
    expect(result.warnings[0]).toMatch(/2645/)
    expect(result.warnings[0]).toMatch(/2647/)
  })

  it('does NOT warn when reverse-charge output is balanced by 2647 (domestic, no 2645)', async () => {
    // Domestic reverse charge per ML 16:13 (byggtjänster, electronics > 100k SEK):     // matching input lands on 2647, not 2645. The earlier check missed this.
    const lines: MockLine[] = [
      { account_number: '2614', debit_amount: 0, credit_amount: 500 },  // ruta30
      { account_number: '2647', debit_amount: 500, credit_amount: 0 },  // domestic input → ruta48
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta30).toBe(500)
    expect(result.rutor.ruta48).toBe(500)
    expect(result.rutor.ruta49).toBe(0)
    // No warning: the domestic mirror is correctly booked.
    expect(result.warnings).toEqual([])
  })

  it('expanded ruta05 includes alternative BAS revenue accounts (3041/3051/3071) AND taxable EU goods (3106)', async () => {
    const lines: MockLine[] = [
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3041', debit_amount: 0, credit_amount: 500 },  // service 25%
      { account_number: '3051', debit_amount: 0, credit_amount: 300 },  // goods 25%
      { account_number: '3071', debit_amount: 0, credit_amount: 200 },  // other domestic
      { account_number: '3106', debit_amount: 0, credit_amount: 100 },  // momspliktig EU goods
    ]

    const result = await computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(2100)
  })

  it('excludes 3004 (momsfri) from ruta05: exempt sales must NOT be in the taxable base', async () => {
    const lines: MockLine[] = [
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '3004', debit_amount: 0, credit_amount: 500 }, // exempt: must be excluded
    ]

    const result = await computeVatReport(
      { period_type: 'yearly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(1000)
  })

  it('aggregates 3108 → ruta35 (EU intra-community goods, momsfri leverans till EU)', async () => {
    const lines: MockLine[] = [
      // Domestic taxable sale
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      // EU goods supply, momsfri (zero-rated to EU customer with valid VAT number)
      { account_number: '3108', debit_amount: 0, credit_amount: 5000 },
    ]

    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta05).toBe(1000)        // 3108 NOT in ruta05 (it's reported separately)
    expect(result.rutor.ruta35).toBe(5000)        // The new ruta we just added
    expect(result.rutor.ruta39).toBe(0)
    expect(result.rutor.ruta40).toBe(0)
  })

  it('refund summary string when ruta49 is negative', async () => {
    const lines: MockLine[] = [
      { account_number: '2641', debit_amount: 100, credit_amount: 0 },
      // No output VAT; pure refund position.
    ]

    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 1 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta49).toBe(-100)
    expect(result.summary).toContain('Moms att få tillbaka')
  })

  it('exposes a rich outputSchema on both VAT tools (not bare {type:object})', () => {
    for (const name of ['gnubok_get_vat_report', 'gnubok_vat_review_widget']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, `tool ${name}`).toBeDefined()
      const schema = tool!.outputSchema as Record<string, unknown> | undefined
      expect(schema).toBeDefined()
      expect(schema!.type).toBe('object')
      const props = schema!.properties as Record<string, unknown>
      // The schema must declare period, period_label, rutor, summary, warnings.
      expect(props).toHaveProperty('period')
      expect(props).toHaveProperty('rutor')
      expect(props).toHaveProperty('summary')
      expect(props).toHaveProperty('warnings')
      // rutor must declare each ruta the runtime returns.
      const rutorProps = (props.rutor as { properties: Record<string, unknown> }).properties
      for (const r of ['ruta05', 'ruta10', 'ruta11', 'ruta12', 'ruta30', 'ruta31', 'ruta32', 'ruta35', 'ruta39', 'ruta40', 'ruta48', 'ruta49']) {
        expect(rutorProps, `tool ${name} rutor.${r}`).toHaveProperty(r)
      }
    }
  })

  it('rejects bad period_type / out-of-range period / out-of-range year', async () => {
    const supabase = mockSupabaseWithLines([])

    await expect(
      computeVatReport({ period_type: 'weekly', year: 2026, period: 1 }, 'c', supabase)
    ).rejects.toThrow(/period_type/)

    await expect(
      computeVatReport({ period_type: 'monthly', year: 2026, period: 13 }, 'c', supabase)
    ).rejects.toThrow(/period must be 1-12/)

    await expect(
      computeVatReport({ period_type: 'quarterly', year: 2026, period: 5 }, 'c', supabase)
    ).rejects.toThrow(/period must be 1-4/)

    await expect(
      computeVatReport({ period_type: 'monthly', year: 1900, period: 1 }, 'c', supabase)
    ).rejects.toThrow(/year must be between/)
  })
})
