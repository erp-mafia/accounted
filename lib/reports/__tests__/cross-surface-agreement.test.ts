/**
 * Cross-surface agreement on one closed fiscal year.
 *
 * Every problem the year-end pipeline has produced for a real customer was a
 * disagreement between two screens, not a single wrong screen: the
 * årsredovisning said one thing and INK2 said another, so the customer became
 * the reconciliation engine. Per-surface tests cannot catch that; this file
 * tests the agreement itself.
 *
 * There are deliberately TWO families, and they are allowed to disagree with
 * each other while Stage 2 of #1051 is outstanding (DECISIONS.md:632):
 *
 *   statutory   (closingEntry 'exclude-final' + a post-closing balance sheet)
 *               reports årets resultat AFTER bokslutsdispositioner and skatt.
 *   operational (closingEntry 'exclude-all-year-end')
 *               reports the result BEFORE them.
 *
 * Within a family the numbers must be identical. The gap BETWEEN the families
 * is asserted explicitly, so when Stage 2 moves generateIncomeStatement to
 * 'exclude-final' this test says exactly which expectations must change instead
 * of failing vaguely.
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
import { mapTrialBalancesToK2 } from '@/lib/bokslut/ixbrl/k2-mapper'
import {
  CLOSED_ROWS,
  EXPECTED,
  PRE_CLOSING_ROWS,
  rowsForMode,
} from './closed-year-fixture'

const COMPANY_ID = 'company-1'
const PERIOD_ID = 'period-1'

function makeSupabase() {
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
    entity_type: 'aktiebolag',
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
    return c
  }
  return {
    from: (table: string) => {
      if (table === 'fiscal_periods') return chain({ data: period, error: null })
      if (table === 'company_settings') return chain({ data: settings, error: null })
      if (table === 'companies') return chain({ data: { entity_type: 'aktiebolag' }, error: null })
      if (table === 'journal_entries') return chain({ data: { status: 'posted' }, error: null })
      return chain({ data: [], error: null })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
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

describe('statutory surfaces agree on årets resultat', () => {
  it('INK2R 7450 and the K2 årsredovisning report the same figure', async () => {
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    expect(ink2.ink2r['7450']).toBe(EXPECTED.netResult)
    expect(k2.totals.aretsResultat.current).toBe(EXPECTED.netResult)
    expect(ink2.ink2r['7450']).toBe(k2.totals.aretsResultat.current)
  })

  it('both put the same figure in fritt eget kapital via 2099', async () => {
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    expect(ink2.ink2r['7302']).toBe(EXPECTED.netResult)
    expect(k2.totals.frittEgetKapital.current).toBe(EXPECTED.netResult)
  })

  it('both reclassify the credit skattekonto into skatteskulder', async () => {
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    // 2512 − 2518 = 10 000, plus 1630's reclassified credit of 20 000.
    expect(ink2.ink2r['7368']).toBe(10_000 + EXPECTED.taxAccountCredit)
    expect(k2.br['Skatteskulder'].current).toBe(10_000 + EXPECTED.taxAccountCredit)
  })

  it('both reclassify the input-VAT debit into övriga fordringar', async () => {
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    expect(ink2.ink2r['7261']).toBe(EXPECTED.inputVatDebit)
    expect(k2.br['OvrigaFordringarKortfristiga'].current).toBe(EXPECTED.inputVatDebit)
  })

  it('both balance', async () => {
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const k2 = mapTrialBalancesToK2({ full: CLOSED_ROWS, preClosing: PRE_CLOSING_ROWS }, null)

    expect(ink2.totals.totalAssets).toBe(ink2.totals.totalEquityLiabilities)
    expect(k2.totals.tillgangar.current).toBe(k2.totals.egetKapitalSkulder.current)
    expect(ink2.totals.totalAssets).toBe(k2.totals.tillgangar.current)
  })
})

describe('operational surfaces agree with each other', () => {
  it('Resultaträkning and Resultatrapport report the same result', async () => {
    const is = await generateIncomeStatement(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const rr = await generateResultatrapport(makeSupabase(), COMPANY_ID, PERIOD_ID)

    expect(is.net_result).toBe(EXPECTED.resultAfterFinancial)
    expect(rr.net_result_current).toBe(EXPECTED.resultAfterFinancial)
    expect(is.net_result).toBe(rr.net_result_current)
  })

  it('and the same revenue as the statutory family', async () => {
    const is = await generateIncomeStatement(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)

    // Nettoomsättning is unaffected by the dispositions/tax split, so this one
    // figure must match across BOTH families.
    expect(is.total_revenue).toBe(ink2.ink2r['7410'])
  })
})

describe('the known gap between the two families', () => {
  it('is exactly bokslutsdispositioner plus skatt', async () => {
    const is = await generateIncomeStatement(makeSupabase(), COMPANY_ID, PERIOD_ID)
    const ink2 = await generateINK2Declaration(makeSupabase(), COMPANY_ID, PERIOD_ID)

    const gap = is.net_result - ink2.ink2r['7450']
    const dispositionsAndTax = ink2.ink2r['7525'] + ink2.ink2r['7528']

    expect(gap).toBe(dispositionsAndTax)
    expect(gap).toBe(160_000) // 100 000 periodiseringsfond + 60 000 skatt

    // This gap is Stage 2 of #1051, deliberately outstanding
    // (DECISIONS.md:632). When generateIncomeStatement moves to
    // 'exclude-final', the operational family joins the statutory one and this
    // expectation becomes gap === 0.
  })
})
