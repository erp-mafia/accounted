/**
 * Focused tests for computeVatReport: the shared VAT computation used by
 * gnubok_get_vat_report and gnubok_vat_review_widget. These exist because the
 * tools/call integration tests can't reach into the rutor math; this file
 * mocks Supabase to feed synthetic journal entry lines and asserts the rutor
 * shape, ruta48 inclusion of 2647, ruta49 formula, and the one-sided
 * reverse-charge warning.
 *
 * The per-account totals come from the get_vat_declaration_totals RPC, the
 * same aggregate the web momsdeklaration and the Skatteverket submission read.
 * Its double (vat-totals-rpc-double.ts) sums the fixture; which entries the
 * RPC leaves out is covered against real Postgres in tests/pg.
 */
import { describe, it, expect } from 'vitest'
import { computeVatReport, tools } from '../server'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { vatTotalsRpcResult } from './vat-totals-rpc-double'

interface MockLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  journal_entry_id?: string
  journal_entries?: { source_type: string | null }
}

function mockSupabaseWithLines(
  lines: MockLine[],
  fiscalPeriod?: { period_start: string; period_end: string },
  rpcExcludedEntryIds: string[] = [],
) {
  // journal_entries / journal_entry_lines still serve the whole fixture, every
  // entry included, so a report that went back to scanning the journal itself
  // instead of reading the RPC would count what the RPC leaves out.
  const entries = [
    ...new Map(
      lines.map((l, i) => {
        const id = l.journal_entry_id ?? `entry-${i}`
        return [id, { id, source_type: l.journal_entries?.source_type ?? null }]
      }),
    ).values(),
  ]
  const bareLines = lines.map((l, i) => ({
    id: `line-${String(i).padStart(4, '0')}`,
    journal_entry_id: l.journal_entry_id ?? `entry-${i}`,
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
  }))

  const makeChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null }
    chain.range = () => settled
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of ['order', 'lte', 'gte', 'neq', 'in', 'not', 'eq', 'select', 'limit', 'contains', 'filter']) {
      chain[m] = () => chain
    }
    return chain
  }

  return {
    // chart_of_accounts feeds fetchDynamicVatAccounts (the company's own
    // ruta 05 konton). Empty here: these fixtures are plain BAS charts, and the
    // dynamic path has its own coverage in lib/reports/__tests__.
    from: (table: string) => {
      // The report reads journal_entries only for the tagged vat_settlement
      // list; filters are no-ops here, so the tag is applied by hand.
      if (table === 'journal_entries') {
        return makeChain(entries.filter((e) => e.source_type === 'vat_settlement'))
      }
      if (table === 'chart_of_accounts') return makeChain([])
      if (table === 'fiscal_periods') return makeChain(fiscalPeriod ? [fiscalPeriod] : [])
      return makeChain(bareLines)
    },
    rpc: (fn: string, params?: { p_accounts?: string[] }) =>
      Promise.resolve(
        fn === 'get_vat_declaration_totals'
          ? vatTotalsRpcResult({ lines: bareLines, excludedEntryIds: rpcExcludedEntryIds }, params)
          : { data: null, error: null },
      ),
  } as never
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

  // #2919: the basis boxes were computed but never returned, so an agent saw
  // ruta 30 and 48 with no way to tell rutor 20-24 were empty (FK004).
  it('returns the reverse-charge basis rutor 20-24 next to ruta 30', async () => {
    const lines: MockLine[] = [
      // Non-EU service, cost on 6540 with the basis pair 4531/4598
      { account_number: '6540', debit_amount: 250, credit_amount: 0, journal_entry_id: 'rc-1' },
      { account_number: '1930', debit_amount: 0, credit_amount: 250, journal_entry_id: 'rc-1' },
      { account_number: '2645', debit_amount: 62.5, credit_amount: 0, journal_entry_id: 'rc-1' },
      { account_number: '2614', debit_amount: 0, credit_amount: 62.5, journal_entry_id: 'rc-1' },
      { account_number: '4531', debit_amount: 250, credit_amount: 0, journal_entry_id: 'rc-1' },
      { account_number: '4598', debit_amount: 0, credit_amount: 250, journal_entry_id: 'rc-1' },
      // EU goods and EU services booked straight on their basis accounts
      { account_number: '4515', debit_amount: 400, credit_amount: 0, journal_entry_id: 'rc-2' },
      { account_number: '4535', debit_amount: 100, credit_amount: 0, journal_entry_id: 'rc-3' },
      // Domestic reverse charge, goods and services
      { account_number: '4415', debit_amount: 80, credit_amount: 0, journal_entry_id: 'rc-4' },
      { account_number: '4425', debit_amount: 60, credit_amount: 0, journal_entry_id: 'rc-5' },
    ]

    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta20).toBe(400)
    expect(result.rutor.ruta21).toBe(100)
    expect(result.rutor.ruta22).toBe(250)
    expect(result.rutor.ruta23).toBe(80)
    expect(result.rutor.ruta24).toBe(60)
    expect(result.rutor.ruta30).toBe(62.5)
    expect(result.rutor.ruta48).toBe(62.5)
  })

  // Agent feedback seq 911266: the Skatteverket filing carried ruta 50 (import
  // basis 4545-4547) while this report hand-listed 20 rutor and left it out,
  // so an agent checking the declaration before filing could not see it.
  it('returns ruta 50 (import tax base) from 4545 against 4599', async () => {
    const lines: MockLine[] = [
      { account_number: '4545', debit_amount: 8000, credit_amount: 0, journal_entry_id: 'imp-1' },
      { account_number: '4599', debit_amount: 0, credit_amount: 8000, journal_entry_id: 'imp-1' },
      { account_number: '2615', debit_amount: 0, credit_amount: 2000, journal_entry_id: 'imp-2' },
      { account_number: '2645', debit_amount: 2000, credit_amount: 0, journal_entry_id: 'imp-2' },
    ]

    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 2 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    expect(result.rutor.ruta50).toBe(8000)
    expect(result.rutor.ruta60).toBe(2000)
    expect(result.rutor.ruta48).toBe(2000)
    expect(result.rutor.ruta49).toBe(0)
  })

  it('returns every SKV 4700 box the declaration has, each declared in the outputSchema', async () => {
    const lines: MockLine[] = [
      { account_number: '3105', debit_amount: 0, credit_amount: 700, journal_entry_id: 'exp-1' },
      { account_number: '1510', debit_amount: 700, credit_amount: 0, journal_entry_id: 'exp-1' },
    ]
    const result = await computeVatReport(
      { period_type: 'monthly', year: 2026, period: 4 },
      'company-1',
      mockSupabaseWithLines(lines)
    )

    // 3105 is export of goods: ruta 36, which the hand-listed view dropped.
    expect(result.rutor.ruta36).toBe(700)

    const expected = [
      'ruta05', 'ruta06', 'ruta07', 'ruta08', 'ruta10', 'ruta11', 'ruta12',
      'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32',
      'ruta35', 'ruta36', 'ruta37', 'ruta38', 'ruta39', 'ruta40', 'ruta41', 'ruta42',
      'ruta48', 'ruta49', 'ruta50', 'ruta60', 'ruta61', 'ruta62',
    ]
    expect(Object.keys(result.rutor).sort()).toEqual([...expected].sort())

    // The schema lists exactly the boxes the runtime returns. It declares no
    // `required` list (tools/list budget): this assertion is the guarantee.
    for (const name of ['gnubok_get_vat_report', 'gnubok_vat_review_widget']) {
      const tool = tools.find((t) => t.name === name)
      const rutorSchema = (tool!.outputSchema as {
        properties: { rutor: { properties: Record<string, unknown> } }
      }).properties.rutor
      expect(Object.keys(rutorSchema.properties).sort(), name).toEqual([...expected].sort())
    }
  })

  it('reports rutor 20-24 as zero when only the fiktiv pair was booked (the #2919 shape)', async () => {
    const lines: MockLine[] = [
      { account_number: '6540', debit_amount: 250, credit_amount: 0, journal_entry_id: 'rc-1' },
      { account_number: '1930', debit_amount: 0, credit_amount: 250, journal_entry_id: 'rc-1' },
      { account_number: '2645', debit_amount: 62.5, credit_amount: 0, journal_entry_id: 'rc-1' },
      { account_number: '2614', debit_amount: 0, credit_amount: 62.5, journal_entry_id: 'rc-1' },
    ]
    const result = await computeVatReport(
      { period_type: 'quarterly', year: 2026, period: 3 },
      'company-1',
      mockSupabaseWithLines(lines)
    )
    expect(result.rutor.ruta30).toBe(62.5)
    expect([result.rutor.ruta20, result.rutor.ruta21, result.rutor.ruta22, result.rutor.ruta23, result.rutor.ruta24])
      .toEqual([0, 0, 0, 0, 0])
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
      mockSupabaseWithLines(lines, {
        period_start: '2025-07-01',
        period_end: '2026-06-30',
      })
    )

    expect(result.rutor.ruta05).toBe(2100)
    expect(result.period.start).toBe('2025-07-01')
    expect(result.period.end).toBe('2026-06-30')
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

  // crm#1139: an annual period (broken fiscal year) read before and after
  // year-end closing. The bokslutsverifikat zeroes class 3-8 against 2099:
  // it debits the sales accounts and credits the EU purchase basis accounts.
  // The report summed it straight into the rutor, so ruta 05 and rutor 20-24
  // read 0 once the year was closed while 26xx (untouched by the closing)
  // stayed. get_vat_declaration_totals leaves the posted closing entry out.
  const CLOSED_YEAR: MockLine[] = [
    // Sale 25 %
    { journal_entry_id: 'sale', account_number: '1510', debit_amount: 5769.31, credit_amount: 0 },
    { journal_entry_id: 'sale', account_number: '3001', debit_amount: 0, credit_amount: 4615.45 },
    { journal_entry_id: 'sale', account_number: '2611', debit_amount: 0, credit_amount: 1153.86 },
    // EU service purchase with the basis pair and both fiktiv moms legs
    { journal_entry_id: 'eu', account_number: '6540', debit_amount: 448.41, credit_amount: 0 },
    { journal_entry_id: 'eu', account_number: '1930', debit_amount: 0, credit_amount: 448.41 },
    { journal_entry_id: 'eu', account_number: '4535', debit_amount: 448.41, credit_amount: 0 },
    { journal_entry_id: 'eu', account_number: '4598', debit_amount: 0, credit_amount: 448.41 },
    { journal_entry_id: 'eu', account_number: '2614', debit_amount: 0, credit_amount: 112.1 },
    { journal_entry_id: 'eu', account_number: '2645', debit_amount: 112.1, credit_amount: 0 },
    // Bokslutsverifikat (source_type year_end): every result account to 2099
    { journal_entry_id: 'closing', account_number: '3001', debit_amount: 4615.45, credit_amount: 0, journal_entries: { source_type: 'year_end' } },
    { journal_entry_id: 'closing', account_number: '4535', debit_amount: 0, credit_amount: 448.41, journal_entries: { source_type: 'year_end' } },
    { journal_entry_id: 'closing', account_number: '4598', debit_amount: 448.41, credit_amount: 0, journal_entries: { source_type: 'year_end' } },
    { journal_entry_id: 'closing', account_number: '6540', debit_amount: 0, credit_amount: 448.41, journal_entries: { source_type: 'year_end' } },
    { journal_entry_id: 'closing', account_number: '2099', debit_amount: 0, credit_amount: 4167.04, journal_entries: { source_type: 'year_end' } },
  ]
  const FISCAL_YEAR = { period_start: '2025-10-01', period_end: '2026-09-30' }
  const YEARLY = { period_type: 'yearly', year: 2026, period: 1 }

  it('keeps ruta 05 and rutor 20-24 after year-end closing (crm#1139)', async () => {
    const result = await computeVatReport(
      YEARLY,
      'company-1',
      mockSupabaseWithLines(CLOSED_YEAR, FISCAL_YEAR, ['closing']),
    )

    expect(result.period.start).toBe('2025-10-01')
    expect(result.period.end).toBe('2026-09-30')
    expect(result.rutor.ruta05).toBe(4615.45)
    expect(result.rutor.ruta21).toBe(448.41)
    expect(result.rutor.ruta10).toBe(1153.86)
    expect(result.rutor.ruta30).toBe(112.1)
    expect(result.rutor.ruta48).toBe(112.1)
    expect(result.rutor.ruta49).toBe(1153.86)
  })

  it('agrees box for box with the momsdeklaration the web files and Skatteverket receives', async () => {
    const supabase = mockSupabaseWithLines(CLOSED_YEAR, FISCAL_YEAR, ['closing'])
    const [report, declaration] = await Promise.all([
      computeVatReport(YEARLY, 'company-1', supabase),
      calculateVatDeclaration(supabase, 'company-1', 'yearly', 2026, 1),
    ])

    for (const [box, filed] of Object.entries(declaration.rutor)) {
      const expected = box === 'ruta49' ? filed : Math.abs(filed)
      expect(report.rutor[box as keyof typeof report.rutor], box).toBe(expected)
    }
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
      for (const r of ['ruta05', 'ruta10', 'ruta11', 'ruta12', 'ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24', 'ruta30', 'ruta31', 'ruta32', 'ruta35', 'ruta39', 'ruta40', 'ruta48', 'ruta49']) {
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

  it('answers a missing argument with VALIDATION_ERROR instead of computing on NaN', async () => {
    const supabase = mockSupabaseWithLines([])
    // A monthly call without `period` used to pass the range check as NaN
    // (NaN < 1 is false) and reach the period-date arithmetic.
    for (const args of [
      { period_type: 'monthly', year: 2026 },
      { period_type: 'quarterly', period: 1 },
      { year: 2026, period: 1 },
    ]) {
      await expect(computeVatReport(args, 'c', supabase), JSON.stringify(args)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    }
  })
})
