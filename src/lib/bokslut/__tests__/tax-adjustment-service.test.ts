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
  it("reads every voucher of the year but the resultatavslut, a bokslut voucher's cost included", async () => {
    await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')

    // A kontantmetod year-end carry or an accrual is a year_end voucher: its
    // 6072 representation is the year's non-deductible cost like any other.
    expect(generateTrialBalance).toHaveBeenCalledWith(expect.anything(), 'company-1', 'period-1', {
      closingEntry: 'exclude-final',
    })
  })

  it('detects Miles account balances as non-deductible expenses', async () => {
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')

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

  it('adds non-deductible representation (6072) to 4.3c and tax-free interest (8314) to 4.5c (crm#1681)', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValueOnce({
      rows: [
        { account_number: '6992', closing_debit: 7_035, closing_credit: 0 },
        { account_number: '8423', closing_debit: 980, closing_credit: 0 },
        { account_number: '6072', closing_debit: 1_209.82, closing_credit: 0 },
        { account_number: '8314', closing_debit: 0, closing_credit: 82 },
      ],
      totalDebit: 9_224.82,
      totalCredit: 82,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')

    expect(snapshot.nonDeductibleExpenses).toBe(9_224.82)
    expect(snapshot.nonTaxableIncome).toBe(82)
    expect(snapshot.items.find((item) => item.accountNumber === '6072')).toMatchObject({
      adjustmentType: 'non_deductible_expense',
      amount: 1_209.82,
      included: true,
    })
    expect(snapshot.items.find((item) => item.accountNumber === '8314')).toMatchObject({
      adjustmentType: 'non_taxable_income',
      amount: 82,
      included: true,
    })
  })

  it('leaves tax-free allowances (73xx) alone: tax-free for the employee, deductible for the company', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValueOnce({
      rows: [
        { account_number: '7321', closing_debit: 1_500, closing_credit: 0 },
        { account_number: '7331', closing_debit: 2_500, closing_credit: 0 },
      ],
      totalDebit: 4_000,
      totalCredit: 0,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')

    expect(snapshot.nonDeductibleExpenses).toBe(0)
    expect(snapshot.items.some((item) => item.accountNumber === '7321' || item.accountNumber === '7331')).toBe(false)
  })

  it('fails loudly instead of dropping form-specific accounts when the company row cannot be resolved', async () => {
    // Without a form the snapshot would silently fall back to the base
    // accounts and omit 3901 for an ekonomisk förening; the lookup error
    // must surface instead.
    await expect(loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1')).rejects.toThrow(
      /entity_type/,
    )
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
      'aktiebolag',
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
      'aktiebolag',
    )

    expect(snapshot.nonTaxableIncome).toBe(1_000)
    expect(snapshot.deficitCarryforward).toBe(250_000.5)
    const deficit = snapshot.items.find((item) => item.sourceKey === 'manual:deficit_carryforward')
    expect(deficit?.adjustmentType).toBe('deficit_carryforward')
    expect(deficit?.included).toBe(true)
  })
})

describe('loadTaxAdjustmentSnapshot: ekonomisk förening membership fees', () => {
  it('proposes the 3901 credit balance as non-taxable income (INK2S 4.5c) for the form only', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '3901', closing_debit: 0, closing_credit: 48_000 },
        { account_number: '6992', closing_debit: 1_000, closing_credit: 0 },
      ],
      totalDebit: 1_000,
      totalCredit: 48_000,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

    const forening = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'ekonomisk_forening')
    expect(forening.items.find((item) => item.accountNumber === '3901')).toMatchObject({
      adjustmentType: 'non_taxable_income',
      amount: 48_000,
      included: true,
    })
    expect(forening.nonTaxableIncome).toBe(48_000)
    expect(forening.nonDeductibleExpenses).toBe(1_000)

    const ab = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')
    expect(ab.items.find((item) => item.accountNumber === '3901')).toBeUndefined()
    expect(ab.nonTaxableIncome).toBe(0)
  })

  it('never proposes a debit balance on 3901 as income', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [{ account_number: '3901', closing_debit: 500, closing_credit: 0 }],
      totalDebit: 500,
      totalCredit: 0,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'ekonomisk_forening')
    expect(snapshot.items.find((item) => item.accountNumber === '3901')?.amount).toBe(0)
    expect(snapshot.nonTaxableIncome).toBe(0)
  })
})

describe('loadTaxAdjustmentSnapshot: dividends on shares in an aktiebolag (crm#1726)', () => {
  const dividendBalances = () =>
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '8210', closing_debit: 0, closing_credit: 50_000 },
        { account_number: '8012', closing_debit: 0, closing_credit: 20_000 },
      ],
      totalDebit: 0,
      totalCredit: 70_000,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

  it('offers each dividend account unticked: the user confirms the shares are näringsbetingade', async () => {
    dividendBalances()
    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')

    expect(snapshot.items.find((item) => item.accountNumber === '8210')).toMatchObject({
      source: 'detected',
      adjustmentType: 'non_taxable_income',
      amount: 50_000,
      included: false,
    })
    expect(snapshot.items.find((item) => item.accountNumber === '8012')).toMatchObject({
      amount: 20_000,
      included: false,
    })
    // Unconfirmed, the dividend stays in the tax base.
    expect(snapshot.nonTaxableIncome).toBe(0)
  })

  it('takes a confirmed dividend out of the tax base', async () => {
    dividendBalances()
    const snapshot = await loadTaxAdjustmentSnapshot(
      makeClient([
        {
          source_key: 'account:8210',
          adjustment_type: 'non_taxable_income',
          source: 'detected',
          description: 'Utdelningar på andelar i andra företag',
          account_number: '8210',
          amount: 50_000,
          included: true,
        },
      ]),
      'company-1',
      'period-1',
      'aktiebolag',
    )

    expect(snapshot.items.find((item) => item.accountNumber === '8210')?.included).toBe(true)
    expect(snapshot.nonTaxableIncome).toBe(50_000)
    // Filed on INK2S 4.5b (Utdelning), not the catch-all 4.5c.
    expect(snapshot.items.find((item) => item.accountNumber === '8210')?.ink2sField).toBe('7753')
    expect(snapshot.dividends).toBe(50_000)
  })

  it('does not count a dividend twice when it was already typed in as a manual figure', async () => {
    dividendBalances()
    const snapshot = await loadTaxAdjustmentSnapshot(
      makeClient([
        {
          source_key: 'manual:non_taxable_income',
          adjustment_type: 'non_taxable_income',
          source: 'manual',
          description: 'Ej skattepliktiga intäkter',
          account_number: null,
          amount: 50_000,
          included: true,
        },
      ]),
      'company-1',
      'period-1',
      'aktiebolag',
    )

    expect(snapshot.nonTaxableIncome).toBe(50_000)
  })

  it('is offered to an aktiebolag only', async () => {
    dividendBalances()
    const forening = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'ekonomisk_forening')
    expect(forening.items.find((item) => item.accountNumber === '8210')).toBeUndefined()
  })
})

describe('loadTaxAdjustmentSnapshot: write-downs of financial assets (INK2S 4.3b)', () => {
  it('adds a write-down back on 4.3b, ticked, and takes its reversal out as non-taxable', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [
        { account_number: '6992', closing_debit: 1_000, closing_credit: 0 },
        { account_number: '8271', closing_debit: 1_250_000, closing_credit: 0 },
        { account_number: '8370', closing_debit: 12_500, closing_credit: 0 },
        { account_number: '8281', closing_debit: 0, closing_credit: 40_000 },
      ],
      totalDebit: 1_263_500,
      totalCredit: 40_000,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

    const snapshot = await loadTaxAdjustmentSnapshot(makeClient(), 'company-1', 'period-1', 'aktiebolag')

    expect(snapshot.items.find((item) => item.accountNumber === '8271')).toMatchObject({
      adjustmentType: 'non_deductible_expense',
      amount: 1_250_000,
      included: true,
      ink2sField: '7652',
    })
    expect(snapshot.items.find((item) => item.accountNumber === '8370')).toMatchObject({
      included: true,
      ink2sField: '7652',
    })
    expect(snapshot.items.find((item) => item.accountNumber === '8281')).toMatchObject({
      adjustmentType: 'non_taxable_income',
      amount: 40_000,
      included: true,
    })
    expect(snapshot.items.find((item) => item.accountNumber === '8281')?.ink2sField).toBeUndefined()
    // 4.3b is part of the non-deductible total, beside the 6992 on 4.3c.
    expect(snapshot.nonDeductibleExpenses).toBe(1_263_500)
    expect(snapshot.financialWriteDowns).toBe(1_262_500)
    expect(snapshot.nonTaxableIncome).toBe(40_000)
    expect(snapshot.dividends).toBe(0)
  })

  it('leaves out a write-down the user unticked', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue({
      rows: [{ account_number: '8370', closing_debit: 12_500, closing_credit: 0 }],
      totalDebit: 12_500,
      totalCredit: 0,
      isBalanced: false,
    } as Awaited<ReturnType<typeof generateTrialBalance>>)

    const snapshot = await loadTaxAdjustmentSnapshot(
      makeClient([
        {
          source_key: 'account:8370',
          adjustment_type: 'non_deductible_expense',
          source: 'detected',
          description: 'Nedskrivningar av kortfristiga placeringar',
          account_number: '8370',
          amount: 12_500,
          included: false,
        },
      ]),
      'company-1',
      'period-1',
      'aktiebolag',
    )

    expect(snapshot.nonDeductibleExpenses).toBe(0)
    expect(snapshot.financialWriteDowns).toBe(0)
  })
})
