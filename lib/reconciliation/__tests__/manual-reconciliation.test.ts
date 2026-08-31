import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const trialBalanceMock = vi.fn()
const arMock = vi.fn()
const apMock = vi.fn()
const vacationMock = vi.fn()

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...args),
}))
vi.mock('@/lib/reports/ar-reconciliation', () => ({
  generateARReconciliation: (...args: unknown[]) => arMock(...args),
}))
vi.mock('@/lib/reports/supplier-reconciliation', () => ({
  generateReconciliation: (...args: unknown[]) => apMock(...args),
}))
vi.mock('@/lib/reports/vacation-liability', () => ({
  generateVacationLiability: (...args: unknown[]) => vacationMock(...args),
}))

import {
  buildManualStatus,
  getManualReconciliationStatus,
  listManualAccounts,
  loadBalanceSheetSnapshot,
  type BalanceSheetSnapshot,
} from '../manual-reconciliation'

const COMPANY = 'company-1'
const PERIOD = { id: 'fy-2026', name: 'Räkenskapsår 2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function tbRow(
  account_number: string,
  account_name: string,
  account_class: number,
  opening: number,
  movement: number,
) {
  const closing = opening + movement
  return {
    account_number,
    account_name,
    account_class,
    opening_debit: opening > 0 ? opening : 0,
    opening_credit: opening < 0 ? -opening : 0,
    period_debit: movement > 0 ? movement : 0,
    period_credit: movement < 0 ? -movement : 0,
    closing_debit: closing > 0 ? closing : 0,
    closing_credit: closing < 0 ? -closing : 0,
  }
}

const TB_ROWS = [
  tbRow('1510', 'Kundfordringar', 1, 8000, 4000),
  tbRow('1930', 'Företagskonto', 1, 50000, -12000),
  tbRow('1630', 'Skattekonto', 1, 1200, 300),
  tbRow('2350', 'Banklån', 2, -260000, 10000),
  tbRow('2440', 'Leverantörsskulder', 2, -6000, -1500),
  tbRow('2920', 'Semesterlöneskuld', 2, -30000, -2000),
  tbRow('2990', 'Övriga upplupna kostnader', 2, 0, 0),
  tbRow('3001', 'Försäljning', 3, 0, -90000),
]

function snapshot(): BalanceSheetSnapshot {
  const rows = new Map()
  for (const r of TB_ROWS) {
    if (r.account_class > 2) continue
    rows.set(r.account_number, {
      account_number: r.account_number,
      account_name: r.account_name,
      opening_balance: r.opening_debit - r.opening_credit,
      movement: r.period_debit - r.period_credit,
      closing_balance: r.closing_debit - r.closing_credit,
    })
  }
  return { period: PERIOD, as_of: '2026-07-31', rows }
}

beforeEach(() => {
  vi.clearAllMocks()
  trialBalanceMock.mockReset()
  arMock.mockReset()
  apMock.mockReset()
  vacationMock.mockReset()
  trialBalanceMock.mockResolvedValue({ rows: TB_ROWS })
  arMock.mockResolvedValue({ ar_ledger_total: 12000, account_1510_balance: 12000, difference: 0, is_reconciled: true, unconverted_fx_count: 0 })
  apMock.mockResolvedValue({ supplier_ledger_total: 7000, account_2440_balance: -7500, difference: -500, is_reconciled: false, unconverted_fx_count: 1 })
  vacationMock.mockResolvedValue({ rows: [], totals: { accruedAmount: 32000, accruedAvgifter: 10054, totalLiability: 42054 }, asOfDate: '2026-07-31' })
})

describe('loadBalanceSheetSnapshot', () => {
  it('reads the period containing the date and the trial balance through it, class 1-2 only', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    const snap = await loadBalanceSheetSnapshot(supabase as never, COMPANY, '2026-07-31')
    expect(trialBalanceMock).toHaveBeenCalledWith(supabase, COMPANY, 'fy-2026', { closingEntry: 'include', toDate: '2026-07-31' })
    expect(snap?.rows.has('3001')).toBe(false)
    expect(snap?.rows.get('2350')).toEqual({
      account_number: '2350',
      account_name: 'Banklån',
      opening_balance: -260000,
      movement: 10000,
      closing_balance: -250000,
    })
  })

  it('returns null when no fiscal period covers the date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await loadBalanceSheetSnapshot(supabase as never, COMPANY, '2019-12-31')).toBeNull()
    expect(trialBalanceMock).not.toHaveBeenCalled()
  })
})

describe('buildManualStatus', () => {
  it('compares a liability against its specification in ledger sign and carries the balances', () => {
    const snap = snapshot()
    const specs = new Map([['2440', { amount: -7000, unconverted_fx_count: 1 }]])
    const s = buildManualStatus(snap.rows.get('2440')!, snap, specs)
    expect(s).toMatchObject({
      account_key: 'manual:2440',
      kind: 'manual',
      as_of: '2026-07-31T00:00:00.000Z',
      external_balance: -7000,
      ledger_balance: -7500,
      difference: -500,
      unexplained_difference: -500,
      is_reconciled: false,
      manual: {
        period_id: 'fy-2026',
        opening_balance: -6000,
        movement: -1500,
        closing_balance: -7500,
        specification: { provider: 'ap', amount: -7000, unconverted_fx_count: 1 },
      },
    })
    expect(s.bridge.map((l) => l.key)).toEqual(['specification', 'opening_balance', 'movement', 'ledger_balance'])
    expect(s.bridge[0].label_sv).toMatch(/idag/)
  })

  it('leaves the outside side unknown for an account without a specification', () => {
    const snap = snapshot()
    const s = buildManualStatus(snap.rows.get('2350')!, snap, new Map())
    expect(s).toMatchObject({ external_balance: null, difference: null, unexplained_difference: null, is_reconciled: false })
    expect(s.manual?.specification).toBeNull()
    expect(s.bridge.map((l) => l.key)).toEqual(['opening_balance', 'movement', 'ledger_balance'])
  })
})

describe('getManualReconciliationStatus', () => {
  it('computes the reskontra specification only for its account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    const s = await getManualReconciliationStatus(supabase as never, COMPANY, '1510', { asOf: '2026-07-31' })
    expect(s).toMatchObject({ external_balance: 12000, ledger_balance: 12000, difference: 0, is_reconciled: true })
    expect(arMock).toHaveBeenCalledWith(supabase, COMPANY, 'fy-2026')
    expect(apMock).not.toHaveBeenCalled()
    expect(vacationMock).not.toHaveBeenCalled()
  })

  it('resolves a dormant balance account from the chart as a zero row, and refuses a result account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    enqueue({ data: { account_number: '2390', account_name: 'Övriga långfristiga skulder', account_class: 2 } })
    const s = await getManualReconciliationStatus(supabase as never, COMPANY, '2390', { asOf: '2026-07-31' })
    expect(s).toMatchObject({ account_number: '2390', ledger_balance: 0, external_balance: null })

    enqueue({ data: PERIOD })
    enqueue({ data: { account_number: '3001', account_name: 'Försäljning', account_class: 3 } })
    expect(await getManualReconciliationStatus(supabase as never, COMPANY, '3001', { asOf: '2026-07-31' })).toBeNull()
  })

  it('falls back to an unknown outside side when a specification source fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    vacationMock.mockRejectedValue(new Error('salary module down'))
    const s = await getManualReconciliationStatus(supabase as never, COMPANY, '2920', { asOf: '2026-07-31' })
    expect(s).toMatchObject({ external_balance: null, unexplained_difference: null })
    expect(s?.manual?.specification).toBeNull()
  })
})

describe('listManualAccounts', () => {
  it('lists balance accounts with a balance or movement, minus the fed ones, plus signed dormant ones, with states', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    const signoffs = new Map<string, { through_date: string } | null>([
      ['manual:2350', { through_date: '2026-07-31' }],
      ['manual:2990', { through_date: '2026-06-30' }],
      ['bank:11111111-1111-4111-8111-111111111111', { through_date: '2026-07-31' }],
    ])
    const accounts = await listManualAccounts(supabase as never, COMPANY, {
      asOf: '2026-07-31',
      exclude: new Set(['1930', '1630']),
      signoffs: signoffs as never,
    })
    expect(accounts.map((a) => a.account_number)).toEqual(['1510', '2350', '2440', '2920', '2990'])
    const byNo = Object.fromEntries(accounts.map((a) => [a.account_number, a]))
    // Specification agrees: reconciled without a sign-off.
    expect(byNo['1510'].status?.state).toBe('reconciled')
    // Specification differs by 500: open.
    expect(byNo['2440'].status).toMatchObject({ state: 'open', unexplained_difference: -500 })
    // No specification, but signed through the balansdag: reconciled.
    expect(byNo['2350']).toMatchObject({ signed_off_through: '2026-07-31', status: { state: 'reconciled' } })
    // Vacation liability from payroll: 2920 booked -32000 vs -32000 accrued.
    expect(byNo['2920'].status).toMatchObject({ state: 'reconciled', unexplained_difference: 0 })
    // Dormant but once signed: listed, not attested for this date.
    expect(byNo['2990']).toMatchObject({ signed_off_through: '2026-06-30', status: { state: 'open' } })
    expect(byNo['2990'].source).toEqual({ type: 'manual', synced_at: null, stale: false })
    // One trial balance read, one read per specification source.
    expect(trialBalanceMock).toHaveBeenCalledTimes(1)
    expect(arMock).toHaveBeenCalledTimes(1)
    expect(apMock).toHaveBeenCalledTimes(1)
    expect(vacationMock).toHaveBeenCalledTimes(1)
  })

  it('skips the specification reads when statuses are not wanted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD })
    const accounts = await listManualAccounts(supabase as never, COMPANY, {
      asOf: '2026-07-31',
      exclude: new Set(),
      signoffs: new Map(),
      withStatus: false,
    })
    expect(accounts.every((a) => a.status === null)).toBe(true)
    expect(arMock).not.toHaveBeenCalled()
  })

  it('returns nothing when no period covers the date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    expect(await listManualAccounts(supabase as never, COMPANY, { asOf: '2019-12-31', exclude: new Set(), signoffs: new Map() })).toEqual([])
  })
})
