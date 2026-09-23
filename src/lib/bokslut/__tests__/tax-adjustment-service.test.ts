import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { loadTaxAdjustmentSnapshot } from '../tax-provision/tax-adjustment-service'

function makeClient(rows: unknown[] = []) {
  const result = { data: rows, error: null }
  const handler: ProxyHandler<object> = {
    get(_target, property) {
      if (property === 'then') {
        return (resolve: (value: unknown) => void) => resolve(result)
      }
      return () => new Proxy({}, handler)
    },
  }
  return {
    from: () => new Proxy({}, handler),
  } as unknown as Parameters<typeof loadTaxAdjustmentSnapshot>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(generateTrialBalance).mockResolvedValue({
    rows: [
      {
        account_number: '6992',
        closing_debit: 2_994,
        closing_credit: 0,
      },
      {
        account_number: '8423',
        closing_debit: 2_250,
        closing_credit: 0,
      },
    ],
    totalDebit: 5_244,
    totalCredit: 0,
    isBalanced: false,
  } as Awaited<ReturnType<typeof generateTrialBalance>>)
})

describe('loadTaxAdjustmentSnapshot', () => {
  it('detects Miles account balances as non-deductible expenses', async () => {
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1')

    expect(snapshot.nonDeductibleExpenses).toBe(5_244)
    expect(snapshot.nonTaxableIncome).toBe(0)
    expect(snapshot.items.find((item) => item.accountNumber === '6992')).toMatchObject({
      amount: 2_994,
      included: true,
    })
    expect(snapshot.items.find((item) => item.accountNumber === '8423')).toMatchObject({
      amount: 2_250,
      included: true,
    })
  })

  it('honors saved exclusions and includes manual adjustments', async () => {
    const snapshot = await loadTaxAdjustmentSnapshot(
      makeClient([
        {
          source_key: 'account:8423',
          adjustment_type: 'non_deductible_expense',
          source: 'detected',
          description: 'Räntekostnader för skatter och avgifter',
          account_number: '8423',
          amount: 2_250,
          included: false,
        },
        {
          source_key: 'manual:non_deductible_expenses',
          adjustment_type: 'non_deductible_expense',
          source: 'manual',
          description: 'Ytterligare ej avdragsgilla kostnader',
          account_number: null,
          amount: 100,
          included: true,
        },
      ]),
      'company-1',
      'period-1',
    )

    expect(snapshot.nonDeductibleExpenses).toBe(3_094)
    expect(snapshot.items.find((item) => item.accountNumber === '8423')?.included).toBe(false)
    expect(snapshot.deficitCarryforward).toBe(0)
  })

  it('keeps the prior-year deficit (INK2S 4.14 a) in its own total, apart from non-taxable income', async () => {
    const snapshot = await loadTaxAdjustmentSnapshot(
      makeClient([
        {
          source_key: 'manual:non_taxable_income',
          adjustment_type: 'non_taxable_income',
          source: 'manual',
          description: 'Ej skattepliktiga intäkter',
          account_number: null,
          amount: 1_000,
          included: true,
        },
        {
          source_key: 'manual:deficit_carryforward',
          adjustment_type: 'deficit_carryforward',
          source: 'manual',
          description: 'Outnyttjat underskott från föregående beskattningsår',
          account_number: null,
          amount: 250_000.5,
          included: true,
        },
      ]),
      'company-1',
      'period-1',
    )

    expect(snapshot.nonTaxableIncome).toBe(1_000)
    expect(snapshot.deficitCarryforward).toBe(250_000.5)
    const deficit = snapshot.items.find((item) => item.sourceKey === 'manual:deficit_carryforward')
    expect(deficit?.adjustmentType).toBe('deficit_carryforward')
    expect(deficit?.included).toBe(true)
  })
})
