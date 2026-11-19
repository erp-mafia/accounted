import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { pdfTextStrings } from '@/tests/pdf-text'
import type { OperationContext } from '@/lib/operations/types'
import type { TrialBalanceRow } from '@/types'

const generateTrialBalance = vi.fn()
const generateARLedger = vi.fn()
const resolvePreviousFiscalPeriod = vi.fn()

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => generateTrialBalance(...args),
  fetchTrialBalanceChart: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/reports/ar-ledger', () => ({
  generateARLedger: (...args: unknown[]) => generateARLedger(...args),
}))
vi.mock('@/lib/core/bookkeeping/period-service', () => ({
  resolvePreviousFiscalPeriod: (...args: unknown[]) => resolvePreviousFiscalPeriod(...args),
}))

import {
  buildForenklatArsbokslut,
  getForenklatArsbokslut,
  getForenklatArsbokslutPdfFile,
} from '../service'

const COMPANY = 'company-1'
const PERIOD = '11111111-1111-4111-8111-111111111111'
const PREVIOUS = '22222222-2222-4222-8222-222222222222'

function rows(balances: Record<string, number>): TrialBalanceRow[] {
  return Object.entries(balances).map(([account_number, balance]) => ({
    account_number,
    account_name: `Konto ${account_number}`,
    account_class: Number(account_number[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: balance > 0 ? balance : 0,
    closing_credit: balance < 0 ? -balance : 0,
  }))
}

// Medlemsavgifter 50 000, costs 30 000: överskott 20 000 on 2069.
const RESULT = { '3901': -50_000, '5010': 30_000 }
const BALANCE = { '1930': 120_000, '2440': -10_000, '2067': -90_000 }

function books(periodId: string, mode: 'include' | 'exclude-final') {
  if (periodId === PREVIOUS) {
    return mode === 'include' ? rows({ '1930': 90_000, '2067': -90_000 }) : rows({ '1930': 90_000, '2067': -90_000 })
  }
  return mode === 'include' ? rows({ ...BALANCE, '2069': -20_000 }) : rows({ ...RESULT, ...BALANCE })
}

let mock: ReturnType<typeof createTableMockSupabase>

function ctx(): OperationContext {
  return {
    supabase: mock.supabase as never,
    companyId: COMPANY,
    userId: 'user-1',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
  }
}

function setup(overrides: { entityType?: string; confirmed?: boolean; period?: unknown } = {}) {
  mock = createTableMockSupabase({
    fiscal_periods: {
      data:
        overrides.period === undefined
          ? {
              id: PERIOD,
              name: '2026',
              period_start: '2026-01-01',
              period_end: '2026-12-31',
              is_closed: true,
              previous_period_id: PREVIOUS,
            }
          : overrides.period,
    },
    company_settings: {
      data: { company_name: 'Testföreningen', org_number: '8020001234', entity_type: overrides.entityType ?? 'ideell_forening' },
    },
    forenklat_arsbokslut_inputs: {
      data:
        overrides.confirmed === false
          ? null
          : {
              eligibility_confirmed_at: '2027-03-01T10:00:00Z',
              notes: 'Not 1 Eget kapital: ändamålsbestämda medel ingår med 10 000 kr.',
              signatories: [
                { name: 'Ledamot A', role: 'ordförande' },
                { name: 'Ledamot B', role: null },
              ],
              updated_at: '2027-03-01T10:00:00Z',
            },
    },
    invoice_items: { data: [] },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  generateTrialBalance.mockImplementation(async (_s: unknown, _c: unknown, periodId: string, opts: { closingEntry: 'include' | 'exclude-final' }) => ({
    rows: books(periodId, opts.closingEntry),
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  }))
  generateARLedger.mockResolvedValue({ entries: [] })
  resolvePreviousFiscalPeriod.mockResolvedValue({
    id: PREVIOUS,
    name: '2025',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    is_closed: true,
    previous_period_id: null,
  })
  setup()
})

describe('buildForenklatArsbokslut', () => {
  it('builds the statements, the inputs and no blockers for a closed, confirmed year', async () => {
    const report = await buildForenklatArsbokslut(mock.supabase as never, COMPANY, PERIOD)
    expect(report.regelverk).toBe('BFNAR 2010:1')
    expect(report.company).toEqual({ name: 'Testföreningen', org_number: '8020001234' })
    expect(report.fiscal_period).toMatchObject({ fiscal_period_id: PERIOD, is_closed: true })
    expect(report.previous_period).toMatchObject({ fiscal_period_id: PREVIOUS, name: '2025' })
    expect(report.totals.aretsOverUnderskott).toEqual({ current: 20_000, previous: 0 })
    expect(report.eligibility).toEqual({ confirmed: true, confirmed_at: '2027-03-01T10:00:00Z' })
    expect(report.signatories).toHaveLength(2)
    expect(report.blockers).toEqual([])
    expect(report.warnings).toEqual([])
    // The two variants, both for each year.
    expect(generateTrialBalance.mock.calls.map((c) => [c[2], c[3].closingEntry]).sort()).toEqual([
      [PERIOD, 'exclude-final'],
      [PERIOD, 'include'],
      [PREVIOUS, 'exclude-final'],
      [PREVIOUS, 'include'],
    ])
  })

  it('blocks the document until the eligibility is confirmed', async () => {
    setup({ confirmed: false })
    const report = await buildForenklatArsbokslut(mock.supabase as never, COMPANY, PERIOD)
    expect(report.eligibility.confirmed).toBe(false)
    expect(report.blockers.map((b) => b.code)).toEqual(['ELIGIBILITY_NOT_CONFIRMED'])
    expect(report.blockers[0].message).toContain('BFL 6 kap. 3 §')
  })

  it('warns about medlemsavgifter still invoiced and unpaid on the balansdag', async () => {
    generateARLedger.mockResolvedValue({
      entries: [{ invoices: [{ invoice_id: 'inv-1', invoice_number: '1042' }, { invoice_id: 'inv-2', invoice_number: '1043' }] }],
    })
    mock.setTable('invoice_items', { data: [{ invoice_id: 'inv-2' }] })
    const report = await buildForenklatArsbokslut(mock.supabase as never, COMPANY, PERIOD)
    expect(generateARLedger).toHaveBeenCalledWith(mock.supabase, COMPANY, '2026-12-31')
    expect(report.warnings.map((w) => w.code)).toEqual(['MEMBER_FEE_RECEIVABLES'])
    expect(report.warnings[0].message).toContain('1043')
    expect(report.warnings[0].message).not.toContain('1042')
    expect(mock.findCall('invoice_items', 'eq')).toEqual(['revenue_account', '3901'])
  })

  it('keeps going without comparatives when the previous year cannot be read', async () => {
    generateTrialBalance.mockImplementation(async (_s: unknown, _c: unknown, periodId: string, opts: { closingEntry: 'include' | 'exclude-final' }) => {
      if (periodId === PREVIOUS) throw new Error('boom')
      return { rows: books(periodId, opts.closingEntry), totalDebit: 0, totalCredit: 0, isBalanced: true }
    })
    const report = await buildForenklatArsbokslut(mock.supabase as never, COMPANY, PERIOD)
    expect(report.previous_period).toBeNull()
    expect(report.warnings.map((w) => w.code)).toEqual(['COMPARATIVE_YEAR_UNAVAILABLE'])
  })
})

describe('getForenklatArsbokslut (doors)', () => {
  it('answers the report', async () => {
    const outcome = await getForenklatArsbokslut(ctx(), PERIOD)
    expect(outcome).toMatchObject({ ok: true, data: { regelverk: 'BFNAR 2010:1' } })
  })

  it('refuses a form that does not prepare one', async () => {
    setup({ entityType: 'aktiebolag' })
    expect(await getForenklatArsbokslut(ctx(), PERIOD)).toEqual({ ok: false, code: 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM' })
  })

  it('answers 404 for a period that is not the company\'s', async () => {
    setup({ period: null })
    expect(await getForenklatArsbokslut(ctx(), PERIOD)).toEqual({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
  })

  it('maps an unexpected failure to REPORT_GENERATION_FAILED and logs it', async () => {
    generateTrialBalance.mockRejectedValue(new Error('db down'))
    const context = ctx()
    expect(await getForenklatArsbokslut(context, PERIOD)).toEqual({ ok: false, code: 'REPORT_GENERATION_FAILED' })
    expect(context.log.error).toHaveBeenCalled()
  })
})

describe('getForenklatArsbokslutPdfFile', () => {
  it('refuses the PDF with the reasons while a blocker holds', async () => {
    setup({ confirmed: false })
    const outcome = await getForenklatArsbokslutPdfFile(ctx(), PERIOD)
    expect(outcome).toMatchObject({ ok: false, code: 'FORENKLAT_ARSBOKSLUT_BLOCKED' })
    if (outcome.ok) throw new Error('expected a refusal')
    expect(String(outcome.details?.reason)).toContain('Bekräfta')
  })

  it('renders the bilaga 2 document with comparatives, notes and one signature block per ledamot', async () => {
    const outcome = await getForenklatArsbokslutPdfFile(ctx(), PERIOD)
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a file')
    expect(outcome.data.filename).toBe('forenklat-arsbokslut-2026-12-31.pdf')
    expect(outcome.data.contentType).toBe('application/pdf')
    const bytes = Buffer.from(outcome.data.bytes)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    const text = pdfTextStrings(bytes).join(' ')
    for (const expected of [
      'Testföreningen',
      'Förenklat årsbokslut för räkenskapsåret 2026-01-01 - 2026-12-31',
      'Resultaträkning',
      'Medlemsavgifter',
      'Övriga externa kostnader',
      'Årets över-/underskott',
      'Balansräkning',
      'Summa eget kapital och skulder',
      'Tilläggsupplysningar',
      'Beslutat',
      'Ledamot A',
      'ordförande',
      'Ledamot B',
    ]) {
      expect(text, expected).toContain(expected)
    }
    // The posts are the document: never an account number.
    expect(text).not.toContain('3901')
    expect(text).not.toContain('1930')
  }, 30_000)
})
