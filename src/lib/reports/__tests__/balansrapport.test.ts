import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

vi.mock('../imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(),
  buildImbalanceDiagnosis: vi.fn(),
}))

// Mocked rather than fed through the queued Supabase stub: the queue resolves
// in strict call order, so an extra real query inside the engine would shift
// every enqueued response in this file.
vi.mock('../latest-vouchers', () => ({
  getLatestPostedVouchers: vi.fn(),
}))

import { generateBalansrapport } from '../balansrapport'
import { generateTrialBalance } from '../trial-balance'
import { findUntransferredResults, buildImbalanceDiagnosis } from '../imbalance-diagnosis'
import { getLatestPostedVouchers } from '../latest-vouchers'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { roundOre } from '@/lib/money'
import type {
  BalansrapportGroup,
  BalansrapportRow,
  BalansrapportSection,
  EntityType,
  TrialBalanceRow,
} from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockFindUntransferred = vi.mocked(findUntransferredResults)
const mockBuildDiagnosis = vi.mocked(buildImbalanceDiagnosis)
const mockLatestVouchers = vi.mocked(getLatestPostedVouchers)

beforeEach(() => {
  vi.clearAllMocks()
  mockLatestVouchers.mockResolvedValue([])
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '1930',
    account_name: 'Bank',
    account_class: 1,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
}

function tb(rows: TrialBalanceRow[]) {
  const totalDebit = rows.reduce((s, r) => s + r.closing_debit, 0)
  const totalCredit = rows.reduce((s, r) => s + r.closing_credit, 0)
  return {
    rows,
    totalDebit: Math.round(totalDebit * 100) / 100,
    totalCredit: Math.round(totalCredit * 100) / 100,
    isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
  }
}

/** The fiscal period, then the company's legal form (resolveCompanyEntityType). */
function enqueuePeriod(
  q: ReturnType<typeof createQueuedMockSupabase>,
  period = { period_start: '2026-01-01', period_end: '2026-12-31' },
  entityType: EntityType = 'aktiebolag',
) {
  q.enqueue({ data: period, error: null })
  q.enqueue({ data: { entity_type: entityType }, error: null })
}

/** Every account row of a class, in report order. */
function accountRows(group: BalansrapportGroup): BalansrapportRow[] {
  const walk = (sections: BalansrapportSection[]): BalansrapportRow[] =>
    sections.flatMap((s) => [...s.rows, ...walk(s.sections)])
  return walk(group.sections)
}

describe('generateBalansrapport', () => {
  it('groups balance accounts into class 1 (assets) and class 2 (equity & liabilities)', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1930',
          account_name: 'Bank',
          account_class: 1,
          opening_debit: 50000,
          opening_credit: 0,
          closing_debit: 75000,
          closing_credit: 0,
        }),
        makeRow({
          account_number: '1510',
          account_name: 'Kundfordringar',
          account_class: 1,
          opening_debit: 10000,
          opening_credit: 0,
          closing_debit: 12500,
          closing_credit: 0,
        }),
        makeRow({
          account_number: '2440',
          account_name: 'Lev.skulder',
          account_class: 2,
          opening_credit: 8000,
          opening_debit: 0,
          closing_credit: 15000,
          closing_debit: 0,
        }),
        makeRow({
          account_number: '2099',
          account_name: 'Årets resultat',
          account_class: 2,
          opening_credit: 52000,
          opening_debit: 0,
          closing_credit: 72500,
          closing_debit: 0,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(2)
    expect(report.groups[0].class).toBe(1)
    expect(report.groups[1].class).toBe(2)

    // Assets sorted by account number
    const assets = report.groups[0]
    expect(accountRows(assets).map((r) => r.account_number)).toEqual(['1510', '1930'])
    expect(accountRows(assets)[1]).toEqual({
      account_number: '1930',
      account_name: 'Bank',
      ib: 50000,
      ub: 75000,
      period_change: 25000,
    })
    expect(assets.subtotal_ib).toBe(60000)
    expect(assets.subtotal_ub).toBe(87500)

    // Equity & liabilities: debit-negative (Fortnox/Visma convention)
    const equity = report.groups[1]
    expect(accountRows(equity)[0]).toEqual({
      account_number: '2099',
      account_name: 'Årets resultat',
      ib: -52000,
      ub: -72500,
      period_change: -20500,
    })
    expect(equity.subtotal_ub).toBe(-87500)

    expect(report.total_assets_ub).toBe(87500)
    expect(report.total_equity_liabilities_ub).toBe(-87500)
    // 2099 already absorbs prior+current result, residual is 0
    expect(report.beraknat_resultat).toBe(0)
    expect(report.is_balanced).toBe(true)
  })

  it('beräknat resultat equals total_assets - total_eq_liab during running year', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    // Mid-year, before any 2099 update: assets 80 000, liabs 30 000.
    // P&L (3001 - 5010) = 50 000 sits in P&L accounts and equals the residual.
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 80000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 30000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 70000 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 20000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.total_assets_ub).toBe(80000)
    expect(report.total_equity_liabilities_ub).toBe(-30000)
    expect(report.beraknat_resultat).toBe(50000)
    // Trial balance still balances: double-entry guarantees this.
    expect(report.is_balanced).toBe(true)
  })

  it('renders class 2 rows with negative sign (god redovisningssed convention)', async () => {
    // Regression test: every Swedish accounting tool (Fortnox, Visma, Bokio,
    // Briox, BL) renders class 2 debit-negative on Balansrapport so that
    // assets + eq_liab = beräknat resultat. Pin this convention.
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1930',
          account_name: 'Bank',
          account_class: 1,
          opening_debit: 100000,
          closing_debit: 120000,
        }),
        makeRow({
          account_number: '2440',
          account_name: 'Lev.skulder',
          account_class: 2,
          opening_credit: 40000,
          closing_credit: 50000,
        }),
        makeRow({
          account_number: '2350',
          account_name: 'Banklån',
          account_class: 2,
          opening_credit: 30000,
          closing_credit: 25000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    const equity = report.groups.find((g) => g.class === 2)!
    // Strict < 0: every fixture row has a nonzero credit balance, so the
    // convention requires every row to be strictly negative.
    expect(accountRows(equity).every((r) => r.ib < 0)).toBe(true)
    expect(accountRows(equity).every((r) => r.ub < 0)).toBe(true)
    expect(equity.subtotal_ib).toBeLessThan(0)
    expect(equity.subtotal_ub).toBeLessThan(0)
    expect(report.total_equity_liabilities_ub).toBeLessThan(0)
    // Sum of both sides equals beräknat resultat (here: profit residual)
    expect(report.total_assets_ub + report.total_equity_liabilities_ub).toBe(
      report.beraknat_resultat
    )
  })

  it('is_balanced reflects trial balance balance state', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    // Manually construct an unbalanced trial balance (in practice the DB
    // trigger prevents this, but a continuity break or missing IB row would
    // surface here).
    mockTrialBalance.mockResolvedValueOnce({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 80000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 70000 }),
      ],
      totalDebit: 80000,
      totalCredit: 70000,
      isBalanced: false,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.is_balanced).toBe(false)
  })

  it('attaches imbalance_diagnosis when the trial balance does not balance', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q, { period_start: '2025-03-01', period_end: '2026-02-28' })

    mockTrialBalance.mockResolvedValueOnce({
      rows: [
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 1097 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 1000 }),
      ],
      totalDebit: 1097,
      totalCredit: 1000,
      isBalanced: false,
    })

    const culprit = {
      fiscal_period_id: 'p2',
      period_name: 'Räkenskapsår 2024/2025',
      pl_net: 97,
    }
    const diagnosis = {
      differens: 97,
      untransferred_results: [culprit],
      message: 'Differensen beror på att resultatet för Räkenskapsår 2024/2025 …',
    }
    mockFindUntransferred.mockResolvedValue([culprit])
    mockBuildDiagnosis.mockReturnValue(diagnosis)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-3')

    expect(mockFindUntransferred).toHaveBeenCalledWith(q.supabase, 'company-1', {
      beforePeriodStart: '2025-03-01',
    })
    expect(mockBuildDiagnosis).toHaveBeenCalledWith([culprit], 97)
    expect(report.imbalance_diagnosis).toEqual(diagnosis)
  })

  it('omits imbalance_diagnosis when the trial balance balances', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 1000 }),
        makeRow({ account_number: '2440', account_name: 'Lev.skuld', account_class: 2, closing_credit: 1000 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.imbalance_diagnosis).toBeUndefined()
    expect(mockFindUntransferred).not.toHaveBeenCalled()
  })

  it('ignores P&L accounts (class 3-8)', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 10000 }),
        makeRow({ account_number: '3001', account_name: 'Revenue', account_class: 3, closing_credit: 50000 }),
        makeRow({ account_number: '5010', account_name: 'Rent', account_class: 5, closing_debit: 8000 }),
        makeRow({ account_number: '8410', account_name: 'Räntekostnad', account_class: 8, closing_debit: 100 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toHaveLength(1)
    expect(report.groups[0].class).toBe(1)
    expect(accountRows(report.groups[0]).map((r) => r.account_number)).toEqual(['1930'])
  })

  it('drops accounts where both IB and UB are zero', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 10000 }),
        makeRow({ account_number: '1940', account_name: 'Inactive', account_class: 1 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(accountRows(report.groups[0])).toHaveLength(1)
    expect(accountRows(report.groups[0])[0].account_number).toBe('1930')
  })

  it('handles accounts that closed during the period (UB=0, IB>0)', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({
          account_number: '1510',
          account_name: 'Kundfordran (betald)',
          account_class: 1,
          opening_debit: 10000,
          period_credit: 10000,
          closing_debit: 10000,
          closing_credit: 10000,
        }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(accountRows(report.groups[0])[0]).toEqual({
      account_number: '1510',
      account_name: 'Kundfordran (betald)',
      ib: 10000,
      ub: 0,
      period_change: -10000,
    })
  })

  it('throws when fiscal period not found', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: null })

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateBalansrapport(q.supabase as any, 'company-1', 'missing')
    ).rejects.toThrow('Fiscal period not found')
  })

  it('returns empty groups when there are no balance accounts at all', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)

    mockTrialBalance.mockResolvedValueOnce(tb([]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(report.groups).toEqual([])
    expect(report.total_assets_ub).toBe(0)
    expect(report.total_equity_liabilities_ub).toBe(0)
    expect(report.beraknat_resultat).toBe(0)
    expect(report.is_balanced).toBe(true)
  })

  describe('latest_vouchers header line', () => {
    function enqueueEmptyPeriod(q: ReturnType<typeof createQueuedMockSupabase>) {
      enqueuePeriod(q)
      mockTrialBalance.mockResolvedValueOnce(tb([]))
    }

    it('carries the last posted voucher per series', async () => {
      const q = createQueuedMockSupabase()
      enqueueEmptyPeriod(q)
      mockLatestVouchers.mockResolvedValueOnce([
        { series: 'A', last_number: 214 },
        { series: 'B', last_number: 37 },
      ])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

      expect(report.latest_vouchers).toEqual([
        { series: 'A', last_number: 214 },
        { series: 'B', last_number: 37 },
      ])
    })

    it('omits the field entirely when the period has no vouchers', async () => {
      const q = createQueuedMockSupabase()
      enqueueEmptyPeriod(q)
      mockLatestVouchers.mockResolvedValueOnce([])

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

      expect('latest_vouchers' in report).toBe(false)
    })

    it('still returns the report when the lookup fails', async () => {
      const q = createQueuedMockSupabase()
      enqueueEmptyPeriod(q)
      mockLatestVouchers.mockRejectedValueOnce(new Error('boom'))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const report = await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

      expect(report.latest_vouchers).toBeUndefined()
      expect(report.is_balanced).toBe(true)
    })

    it('bounds the window at the as-of date with no lower bound (accumulating report)', async () => {
      const q = createQueuedMockSupabase()
      enqueueEmptyPeriod(q)

      await generateBalansrapport(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        q.supabase as any,
        'company-1',
        'period-1',
        { fromDate: '2026-02-01', toDate: '2026-03-31' }
      )

      // fromDate narrows the report's own period label, but a balansrapport
      // accumulates from the fiscal-year start, so the voucher window must not
      // inherit that lower bound.
      expect(mockLatestVouchers).toHaveBeenCalledWith(
        expect.anything(),
        'company-1',
        'period-1',
        { toDate: '2026-03-31' }
      )
    })
  })
})

describe('generateBalansrapport sections (ÅRL bilaga 1 headings)', () => {
  /** A balance on [account]: debit when positive, credit when negative; IB is 80 % of UB. */
  function balance(account: string, ub: number): TrialBalanceRow {
    const ib = Math.round(ub * 0.8)
    return makeRow({
      account_number: account,
      account_name: `Konto ${account}`,
      account_class: Number(account[0]),
      opening_debit: Math.max(ib, 0),
      opening_credit: Math.max(-ib, 0),
      closing_debit: Math.max(ub, 0),
      closing_credit: Math.max(-ub, 0),
    })
  }

  async function report(rows: TrialBalanceRow[], entityType: EntityType = 'aktiebolag') {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q, undefined, entityType)
    mockTrialBalance.mockResolvedValueOnce(tb(rows))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return generateBalansrapport(q.supabase as any, 'company-1', 'period-1')
  }

  /** "label: accounts" per section, nested headings as "heading > section". */
  function outline(group: BalansrapportGroup): string[] {
    const walk = (sections: BalansrapportSection[], prefix: string): string[] =>
      sections.flatMap((s) =>
        s.sections.length > 0
          ? walk(s.sections, `${prefix}${s.label} > `)
          : [`${prefix}${s.label}: ${s.rows.map((r) => r.account_number).join(' ')}`],
      )
    return walk(group.sections, '')
  }

  function allSections(group: BalansrapportGroup): BalansrapportSection[] {
    const walk = (sections: BalansrapportSection[]): BalansrapportSection[] =>
      sections.flatMap((s) => [s, ...walk(s.sections)])
    return walk(group.sections)
  }

  // An aktiebolag's books shaped like the customer's example report.
  const AB_ROWS = [
    balance('1070', 50_000),
    balance('1079', -10_000),
    balance('1220', 80_000),
    balance('1229', -20_000),
    balance('1383', 15_000),
    balance('1460', 30_000),
    balance('1510', 40_000),
    balance('1630', 2_000),
    balance('1686', 500),
    balance('1710', 3_000),
    balance('1790', 1_000),
    balance('1910', 1_500),
    balance('1930', 120_000),
    balance('2081', -25_000),
    balance('2091', -100_000),
    balance('2099', -60_000),
    balance('2110', -20_000),
    balance('2350', -50_000),
    balance('2440', -30_000),
    balance('2641', 4_000),
    balance('2710', -8_000),
    balance('2991', -24_000),
  ]

  it('groups an aktiebolag under the årsredovisning headings, in uppställningsform order', async () => {
    const r = await report(AB_ROWS)

    expect(outline(r.groups[0])).toEqual([
      'Anläggningstillgångar > Immateriella anläggningstillgångar: 1070 1079',
      'Anläggningstillgångar > Materiella anläggningstillgångar: 1220 1229',
      'Anläggningstillgångar > Finansiella anläggningstillgångar: 1383',
      'Omsättningstillgångar > Varulager m.m.: 1460',
      'Omsättningstillgångar > Kortfristiga fordringar: 1510 1630 1686 1710 1790',
      'Omsättningstillgångar > Kassa och bank: 1910 1930',
    ])
    expect(outline(r.groups[1])).toEqual([
      'Eget kapital > Bundet eget kapital: 2081',
      'Eget kapital > Fritt eget kapital: 2091 2099',
      'Obeskattade reserver: 2110',
      'Långfristiga skulder: 2350',
      'Kortfristiga skulder: 2440 2641 2710 2991',
    ])
  })

  it('carries IB, förändring and UB subtotals per section and heading', async () => {
    const r = await report(AB_ROWS)
    const anlaggning = r.groups[0].sections[0]

    expect(anlaggning.key).toBe('anlaggningstillgangar')
    expect(anlaggning.total_label).toBe('Summa anläggningstillgångar')
    expect(anlaggning.sections[1]).toMatchObject({
      key: 'materiellaAnlaggningstillgangar',
      total_label: 'Summa materiella anläggningstillgångar',
      subtotal_ib: 48_000,
      subtotal_change: 12_000,
      subtotal_ub: 60_000,
    })
    expect(anlaggning).toMatchObject({ subtotal_ib: 92_000, subtotal_change: 23_000, subtotal_ub: 115_000 })
  })

  it('sums every section to the class totals, so nothing is lost or counted twice', async () => {
    const r = await report([...AB_ROWS, balance('1200', 700), balance('2010', -900)])

    // Every non-zero input row lands in exactly one section.
    expect(accountRows(r.groups[0])).toHaveLength(14)
    expect(accountRows(r.groups[1])).toHaveLength(10)
    for (const group of r.groups) {
      const rows = accountRows(group)
      expect(group.subtotal_ib).toBe(roundOre(rows.reduce((s, x) => s + x.ib, 0)))
      expect(group.subtotal_ub).toBe(roundOre(rows.reduce((s, x) => s + x.ub, 0)))
      expect(group.subtotal_change).toBe(roundOre(group.subtotal_ub - group.subtotal_ib))
      expect(group.subtotal_ub).toBe(roundOre(group.sections.reduce((s, x) => s + x.subtotal_ub, 0)))
      for (const s of allSections(group)) {
        const parts = s.sections.length > 0
          ? s.sections.map((c) => ({ ib: c.subtotal_ib, ub: c.subtotal_ub, change: c.subtotal_change }))
          : s.rows.map((x) => ({ ib: x.ib, ub: x.ub, change: x.period_change }))
        expect(s.rows.length === 0 || s.sections.length === 0, s.key).toBe(true)
        expect(s.subtotal_ib, s.key).toBe(roundOre(parts.reduce((t, p) => t + p.ib, 0)))
        expect(s.subtotal_ub, s.key).toBe(roundOre(parts.reduce((t, p) => t + p.ub, 0)))
        expect(s.subtotal_change, s.key).toBe(roundOre(parts.reduce((t, p) => t + p.change, 0)))
      }
    }
    expect(r.total_assets_ub).toBe(r.groups[0].subtotal_ub)
    expect(r.total_equity_liabilities_ub).toBe(r.groups[1].subtotal_ub)
  })

  it('lists accounts no balance-sheet post covers apart, last in their class', async () => {
    // 1200 is a BAS group header, 2010 an enskild firma owner account.
    const r = await report([...AB_ROWS, balance('1200', 700), balance('2010', -900)])

    const assetsLast = r.groups[0].sections.at(-1)!
    expect(assetsLast).toMatchObject({ key: 'unclassified', label: 'Ej klassificerade konton', subtotal_ub: 700 })
    expect(assetsLast.rows.map((x) => x.account_number)).toEqual(['1200'])
    const equityLast = r.groups[1].sections.at(-1)!
    expect(equityLast.key).toBe('unclassified')
    expect(equityLast.total_label).toBe('Summa ej klassificerade konton')
    expect(equityLast.rows.map((x) => x.account_number)).toEqual(['2010'])
  })

  it('keeps a credit 1630 and a debit 2641 where they were booked (no sign reclassification)', async () => {
    const r = await report([balance('1630', -5_000), balance('1930', 20_000), balance('2641', 3_000), balance('2440', -18_000)])

    expect(outline(r.groups[0])).toEqual([
      'Omsättningstillgångar > Kortfristiga fordringar: 1630',
      'Omsättningstillgångar > Kassa och bank: 1930',
    ])
    expect(outline(r.groups[1])).toEqual(['Kortfristiga skulder: 2440 2641'])
    expect(accountRows(r.groups[0])[0].ub).toBe(-5_000)
    expect(accountRows(r.groups[1])[1].ub).toBe(3_000)
  })

  it('shows one Eget kapital for an enskild firma, owner accounts included', async () => {
    const r = await report(
      [balance('1930', 40_000), balance('2010', -50_000), balance('2013', 20_000), balance('2018', -5_000), balance('2440', -5_000)],
      'enskild_firma',
    )

    expect(outline(r.groups[1])).toEqual(['Eget kapital: 2010 2013 2018', 'Kortfristiga skulder: 2440'])
    expect(r.groups[1].sections[0]).toMatchObject({ key: 'egetKapital', total_label: 'Summa eget kapital', subtotal_ub: -35_000 })
  })

  it('shows one Eget kapital for an ideell förening', async () => {
    const r = await report([balance('1930', 10_000), balance('2067', -8_000), balance('2069', -2_000)], 'ideell_forening')

    expect(outline(r.groups[1])).toEqual(['Eget kapital: 2067 2069'])
  })

  it('splits an ekonomisk förening into bundet and fritt with member capital, and sets share capital apart', async () => {
    const r = await report(
      [
        balance('1930', 300_000),
        balance('2081', -1_000),
        balance('2083', -200_000),
        balance('2084', -50_000),
        balance('2086', -20_000),
        balance('2091', -9_000),
        balance('2099', -20_000),
      ],
      'ekonomisk_forening',
    )

    expect(outline(r.groups[1])).toEqual([
      'Eget kapital > Bundet eget kapital: 2083 2084 2086',
      'Eget kapital > Fritt eget kapital: 2091 2099',
      'Ej klassificerade konton: 2081',
    ])
  })

  it('reads the legal form from the company', async () => {
    const q = createQueuedMockSupabase()
    enqueuePeriod(q)
    mockTrialBalance.mockResolvedValueOnce(tb([]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await generateBalansrapport(q.supabase as any, 'company-1', 'period-1')

    expect(q.findCall('companies', 'select')).toEqual(['entity_type'])
    expect(q.findCall('companies', 'eq')).toEqual(['id', 'company-1'])
  })
})
