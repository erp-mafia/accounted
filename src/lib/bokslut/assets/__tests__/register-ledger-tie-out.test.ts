import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchAllRowsMock = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...args: unknown[]) => fetchAllRowsMock(...(args as [])),
}))

const trialBalanceMock = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...(args as [])),
}))

import { assetRegisterDifferences } from '../register-ledger-tie-out'

const PERIOD = { id: 'fp-1', period_end: '2026-12-31' }
const supabase = {} as never

function asset(over: Record<string, unknown> = {}) {
  return {
    bas_asset_account: '1220',
    acquisition_cost: 100000,
    acquisition_date: '2026-03-01',
    disposed_at: null,
    ...over,
  }
}

function trialRow(accountNumber: string, closingDebit: number, closingCredit = 0) {
  return { account_number: accountNumber, closing_debit: closingDebit, closing_credit: closingCredit }
}

describe('assetRegisterDifferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports nothing, and reads no trial balance, when the register is empty', async () => {
    fetchAllRowsMock.mockResolvedValue([])

    expect(await assetRegisterDifferences(supabase, 'company-1', PERIOD)).toEqual([])
    expect(trialBalanceMock).not.toHaveBeenCalled()
  })

  it('reports nothing when the account carries the registered cost', async () => {
    fetchAllRowsMock.mockResolvedValue([asset(), asset({ acquisition_cost: '50000.50' })])
    trialBalanceMock.mockResolvedValue({ rows: [trialRow('1220', 150000.5), trialRow('1930', 999)] })

    expect(await assetRegisterDifferences(supabase, 'company-1', PERIOD)).toEqual([])
    expect(trialBalanceMock).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', expect.objectContaining({ closingEntry: 'include' }))
  })

  it('reports a registered asset the account does not carry', async () => {
    fetchAllRowsMock.mockResolvedValue([asset()])
    trialBalanceMock.mockResolvedValue({ rows: [trialRow('1930', 999)] })

    expect(await assetRegisterDifferences(supabase, 'company-1', PERIOD)).toEqual([
      { account_number: '1220', register_cost: 100000, ledger_balance: 0, difference: 100000 },
    ])
  })

  it('reports an account that carries more than the register, per account and in account order', async () => {
    fetchAllRowsMock.mockResolvedValue([asset({ bas_asset_account: '1250', acquisition_cost: 20000 }), asset()])
    trialBalanceMock.mockResolvedValue({ rows: [trialRow('1220', 400000), trialRow('1250', 20000)] })

    expect(await assetRegisterDifferences(supabase, 'company-1', PERIOD)).toEqual([
      { account_number: '1220', register_cost: 100000, ledger_balance: 400000, difference: -300000 },
    ])
  })

  it('leaves out an asset bought after the year and one disposed of by its last day', async () => {
    fetchAllRowsMock.mockResolvedValue([
      asset(),
      asset({ acquisition_date: '2027-01-15', acquisition_cost: 70000 }),
      asset({ disposed_at: '2026-12-31T10:00:00Z', acquisition_cost: 30000 }),
      asset({ disposed_at: '2027-02-01', acquisition_cost: 5000 }),
    ])
    trialBalanceMock.mockResolvedValue({ rows: [trialRow('1220', 105000)] })

    expect(await assetRegisterDifferences(supabase, 'company-1', PERIOD)).toEqual([])
  })

  it('does not report a difference under one krona', async () => {
    fetchAllRowsMock.mockResolvedValue([asset()])
    trialBalanceMock.mockResolvedValue({ rows: [trialRow('1220', 100000.4)] })

    expect(await assetRegisterDifferences(supabase, 'company-1', PERIOD)).toEqual([])
  })
})
