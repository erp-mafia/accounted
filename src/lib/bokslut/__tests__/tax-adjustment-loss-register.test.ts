import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('../loss-carryforward/register', () => ({
  loadRegisterDeficit: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadRegisterDeficit, type RegisterDeficit } from '../loss-carryforward/register'
import { loadTaxAdjustmentSnapshot, saveTaxAdjustments } from '../tax-provision/tax-adjustment-service'

type Client = Parameters<typeof loadTaxAdjustmentSnapshot>[0]

/** A client whose every query answers `rows`; upserts are captured. */
function makeClient(rows: unknown[] = [], upserts: unknown[][] = []): Client {
  const result = { data: rows, error: null }
  const handler: ProxyHandler<object> = {
    get(_target, property) {
      if (property === 'then') return (resolve: (value: unknown) => void) => resolve(result)
      if (property === 'upsert') {
        return (payload: unknown[]) => {
          upserts.push(payload)
          return new Proxy({}, handler)
        }
      }
      return () => new Proxy({}, handler)
    },
  }
  return { from: () => new Proxy({}, handler) } as unknown as Client
}

const manualDeficit = (amount: number) => ({
  source_key: 'manual:deficit_carryforward',
  adjustment_type: 'deficit_carryforward',
  source: 'manual',
  description: 'Outnyttjat underskott från föregående beskattningsår',
  account_number: null,
  amount,
  included: amount > 0,
})

const registerRow: RegisterDeficit = {
  taxLossCarryforwardId: 'tlc-1',
  broughtForward: 100_000,
  amountBlockReduction: 20_000,
  groupBlockReduction: 0,
  deductible: 80_000,
  source: 'tax_assessment',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: [],
    totalDebit: 0,
    totalCredit: 0,
    isBalanced: true,
  } as unknown as Awaited<ReturnType<typeof generateTrialBalance>>)
  vi.mocked(loadRegisterDeficit).mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('loadTaxAdjustmentSnapshot with the underskottsregister', () => {
  it('reads nothing from the register while the switch is off: the manual 4.14 a as before', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    vi.mocked(loadRegisterDeficit).mockResolvedValue(registerRow)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient([manualDeficit(55_000)]), 'company-1', 'period-1', 'aktiebolag')
    expect(loadRegisterDeficit).not.toHaveBeenCalled()
    expect(snapshot.deficitCarryforward).toBe(55_000)
    expect(snapshot).not.toHaveProperty('lossRegister')
  })

  it('reads nothing for a form that does not file INK2', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'enskild_firma')
    expect(loadRegisterDeficit).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveProperty('lossRegister')
  })

  it('keeps the manual 4.14 a when the year has no register row', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'company-1')
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient([manualDeficit(55_000)]), 'company-1', 'period-1', 'aktiebolag')
    expect(loadRegisterDeficit).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1')
    expect(snapshot.deficitCarryforward).toBe(55_000)
    expect(snapshot.lossRegister).toEqual({ row: null, overridden: false })
  })

  it('prefills 4.14 a from the register, net of the spärrar, when nothing manual is saved', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    vi.mocked(loadRegisterDeficit).mockResolvedValue(registerRow)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')
    expect(snapshot.deficitCarryforward).toBe(80_000)
    expect(snapshot.items.find((item) => item.sourceKey === 'manual:deficit_carryforward')).toMatchObject({
      amount: 80_000,
      included: true,
    })
    expect(snapshot.lossRegister).toEqual({ row: registerRow, overridden: false })
  })

  it('lets a saved manual figure that differs override the register, and says so', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    vi.mocked(loadRegisterDeficit).mockResolvedValue(registerRow)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient([manualDeficit(60_000)]), 'company-1', 'period-1', 'aktiebolag')
    expect(snapshot.deficitCarryforward).toBe(60_000)
    expect(snapshot.lossRegister?.overridden).toBe(true)
  })

  it('treats a saved figure equal to the register as no override', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    vi.mocked(loadRegisterDeficit).mockResolvedValue(registerRow)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient([manualDeficit(80_000)]), 'company-1', 'period-1', 'aktiebolag')
    expect(snapshot.deficitCarryforward).toBe(80_000)
    expect(snapshot.lossRegister?.overridden).toBe(false)
  })
})

describe('saveTaxAdjustments with the underskottsregister', () => {
  const input = (deficitCarryforward: number) => ({
    manualAdjustments: { nonDeductibleExpenses: 0, nonTaxableIncome: 0, deficitCarryforward },
    detectedAccounts: {},
  })
  const savedDeficit = (upserts: unknown[][]) =>
    (upserts[0] as Array<{ source_key: string; amount: number; included: boolean }>).find(
      (row) => row.source_key === 'manual:deficit_carryforward',
    )

  it('stores the figure as typed while the switch is off', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '')
    const upserts: unknown[][] = []
    await saveTaxAdjustments(makeClient([], upserts), 'company-1', 'period-1', 'user-1', input(80_000), 'aktiebolag')
    expect(savedDeficit(upserts)).toMatchObject({ amount: 80_000, included: true })
  })

  it('stores no override when the figure is the register\'s, so later register changes flow through', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    vi.mocked(loadRegisterDeficit).mockResolvedValue(registerRow)
    const upserts: unknown[][] = []
    await saveTaxAdjustments(makeClient([], upserts), 'company-1', 'period-1', 'user-1', input(80_000), 'aktiebolag')
    expect(savedDeficit(upserts)).toMatchObject({ amount: 0, included: false })
  })

  it('stores a different figure as the override', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
    vi.mocked(loadRegisterDeficit).mockResolvedValue(registerRow)
    const upserts: unknown[][] = []
    await saveTaxAdjustments(makeClient([], upserts), 'company-1', 'period-1', 'user-1', input(50_000), 'aktiebolag')
    expect(savedDeficit(upserts)).toMatchObject({ amount: 50_000, included: true })
  })
})
