/**
 * Every statement generator, run against one closed fiscal year.
 *
 * This is the test that would have caught the INK2R and NE-bilaga bugs on
 * 2026-07-23, when the same two defects were fixed in the årsredovisning and
 * nowhere else. The old per-generator suites all exercised an OPEN period, the
 * one state in which a generator that forgets the resultatavslut happens to
 * work. Declarations are filed AFTER bokslut, so the untested state was the
 * only state that occurs in production.
 *
 * ADDING A GENERATOR: add a row to GENERATORS. If a new report sums classes 3-8
 * and is not in this table, nothing stops it shipping with the same bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/bokslut/tax-provision/tax-adjustment-service', () => ({
  loadTaxAdjustmentSnapshot: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadTaxAdjustmentSnapshot } from '@/lib/bokslut/tax-provision/tax-adjustment-service'
import { generateIncomeStatement } from '../income-statement'
import { generateResultatrapport } from '../resultatrapport'
import { generateINK2Declaration } from '../ink2/ink2-engine'
import { generateNEDeclaration } from '../ne-bilaga/ne-engine'
import {
  CLOSED_ROWS,
  EXPECTED,
  EX_YEAR_END_ROWS,
  PRE_CLOSING_ROWS,
  balancesToZero,
  rowsForMode,
} from './closed-year-fixture'

const COMPANY_ID = 'company-1'
const PERIOD_ID = 'period-1'

/**
 * Minimal chainable stub. Every generator in the table needs the fiscal period
 * and most need company_settings; INK2 also probes the closing entry's status.
 */
function makeSupabase(entityType: 'aktiebolag' | 'enskild_firma') {
  const period = {
    id: PERIOD_ID,
    name: 'Räkenskapsår 2025',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    is_closed: true,
    closing_entry_id: 'closing-1',
    previous_period_id: null,
  }
  const settings = {
    company_name: 'Testbolaget',
    org_number: '5560000000',
    entity_type: entityType,
    address_line1: 'Testgatan 1',
    postal_code: '11122',
    city: 'Stockholm',
    email: 'test@example.com',
  }

  function chain(result: unknown): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'neq', 'or', 'order', 'limit', 'contains']) {
      c[m] = () => c
    }
    c.single = async () => result
    c.maybeSingle = async () => result
    c.range = async () => result
    c.then = undefined
    return c
  }

  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') return chain({ data: period, error: null })
      if (table === 'company_settings') return chain({ data: settings, error: null })
      if (table === 'companies') return chain({ data: { entity_type: entityType }, error: null })
      // The closing entry's status: posted, so årets resultat is already in 2099.
      if (table === 'journal_entries') return chain({ data: { status: 'posted' }, error: null })
      return chain({ data: [], error: null })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

interface GeneratorCase {
  name: string
  entityType: 'aktiebolag' | 'enskild_firma'
  /** Revenue as the generator reports it, in kronor. */
  revenue: (result: never) => number
  /** The generator's own bottom line, for the subset that computes one. */
  netResult?: (result: never) => number
  expectedNetResult?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (supabase: any) => Promise<any>
}

const GENERATORS: GeneratorCase[] = [
  {
    name: 'Resultaträkning (income-statement)',
    entityType: 'aktiebolag',
    run: (s) => generateIncomeStatement(s, COMPANY_ID, PERIOD_ID),
    // Operational convention: no dispositions, no tax.
    revenue: (r) => revenueFromSections(r),
    netResult: (r) => (r as { net_result: number }).net_result,
    expectedNetResult: EXPECTED.resultAfterFinancial,
  },
  {
    name: 'Resultatrapport',
    entityType: 'aktiebolag',
    run: (s) => generateResultatrapport(s, COMPANY_ID, PERIOD_ID),
    revenue: (r) => {
      const groups = (r as { groups: Array<{ rows: Array<{ account_number: string; current_period: number }> }> }).groups
      for (const g of groups) {
        for (const row of g.rows) if (row.account_number === '3001') return row.current_period
      }
      return 0
    },
    netResult: (r) => (r as { net_result_current: number }).net_result_current,
    expectedNetResult: EXPECTED.resultAfterFinancial,
  },
  {
    name: 'INK2R (räkenskapsschema)',
    entityType: 'aktiebolag',
    run: (s) => generateINK2Declaration(s, COMPANY_ID, PERIOD_ID),
    revenue: (r) => (r as { ink2r: Record<string, number> }).ink2r['7410'],
    netResult: (r) => (r as { ink2r: Record<string, number> }).ink2r['7450'],
    expectedNetResult: EXPECTED.netResult,
  },
  {
    name: 'NE-bilaga',
    entityType: 'enskild_firma',
    run: (s) => generateNEDeclaration(s, COMPANY_ID, PERIOD_ID),
    revenue: (r) => (r as { rutor: Record<string, number> }).rutor.R1,
  },
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function revenueFromSections(report: any): number {
  for (const section of report.revenue_sections ?? []) {
    for (const row of section.rows ?? []) {
      if (row.account_number === '3001') return row.amount
    }
  }
  return 0
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadTaxAdjustmentSnapshot).mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { nonDeductibleExpenses: 0, nonTaxableIncome: 0 } as any,
  )
  vi.mocked(generateTrialBalance).mockImplementation(async (_s, _c, _p, opts) => ({
    rows: rowsForMode(opts.closingEntry),
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  }))
})

describe('statement generators against a closed fiscal year', () => {
  for (const g of GENERATORS) {
    it(`${g.name} reports the year's revenue, not zero`, async () => {
      const result = await g.run(makeSupabase(g.entityType))

      // The regression, in one assertion: a generator that asked for
      // closingEntry 'include' sees a zeroed P&L and reports 0 here.
      expect(g.revenue(result as never)).toBe(EXPECTED.revenue)
    })

    const readNetResult = g.netResult
    const expectedNetResult = g.expectedNetResult
    if (readNetResult && expectedNetResult !== undefined) {
      it(`${g.name} reports its bottom line`, async () => {
        const result = await g.run(makeSupabase(g.entityType))
        expect(readNetResult(result as never)).toBe(expectedNetResult)
      })
    }
  }

  it('has three self-consistent views: every one must balance', () => {
    // A trial balance that does not sum to zero is not a trial balance. The
    // 'exclude-all-year-end' view originally dropped only the P&L legs of the
    // year_end entries and sat 160 000 kr out of balance, which was latent
    // because today's consumers read class 3-8 only.
    expect(balancesToZero(PRE_CLOSING_ROWS)).toBe(0)
    expect(balancesToZero(EX_YEAR_END_ROWS)).toBe(0)
    expect(balancesToZero(CLOSED_ROWS)).toBe(0)
  })

  it('covers every generator that reports a resultaträkning', () => {
    // A tripwire for the next person: this count is the checklist length.
    // Raising it without adding a row means a generator went untested.
    expect(GENERATORS).toHaveLength(4)
  })
})

describe('balance sheet presentation against a closed fiscal year', () => {
  it('INK2R keeps årets resultat in fritt eget kapital exactly once', async () => {
    const result = await generateINK2Declaration(makeSupabase('aktiebolag'), COMPANY_ID, PERIOD_ID)

    // 2099 carries it in the closed books, so the engine must NOT add the
    // computed result on top.
    expect(result.ink2r['7302']).toBe(EXPECTED.netResult)
    expect(result.totals.totalAssets).toBe(result.totals.totalEquityLiabilities)
  })

  it('INK2R presents a credit skattekonto as a liability, not a negative asset', async () => {
    const result = await generateINK2Declaration(makeSupabase('aktiebolag'), COMPANY_ID, PERIOD_ID)

    // 2512 − 2518 = 10 000, plus the reclassified 1630 credit.
    expect(result.ink2r['7368']).toBe(10_000 + EXPECTED.taxAccountCredit)
    expect(result.ink2r['7261']).toBeGreaterThanOrEqual(0)
  })

  it('INK2R presents an input-VAT debit as a receivable, not a negative liability', async () => {
    const result = await generateINK2Declaration(makeSupabase('aktiebolag'), COMPANY_ID, PERIOD_ID)

    expect(result.ink2r['7261']).toBe(EXPECTED.inputVatDebit)
    expect(result.ink2r['7369']).toBe(0)
  })
})
