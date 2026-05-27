import { describe, it, expect } from 'vitest'
import {
  proposeAuditFee,
  proposeManualPrepaid,
  proposeManualAccrued,
  proposeRevenueDeferral,
  proposeAccruedInterest,
  proposeAccruedUtility,
} from '../accruals/accrual-detector'

describe('proposeAuditFee', () => {
  it('defaults to 2992 (revision)', () => {
    const r = proposeAuditFee({ amount: 18_000, closingDate: '2025-12-31' })
    expect(r).not.toBeNull()
    expect(r!.lines[0].account_number).toBe('6420')
    expect(r!.lines[1].account_number).toBe('2992')
    expect(r!.reverses_on).toBe('2026-01-01')
  })

  it('uses 2991 when liabilityAccount=2991 (bokslut)', () => {
    const r = proposeAuditFee({
      amount: 12_000,
      closingDate: '2026-12-31',
      liabilityAccount: '2991',
    })
    expect(r).not.toBeNull()
    expect(r!.lines[1].account_number).toBe('2991')
    expect(r!.reverses_on).toBe('2027-01-01')
  })

  it('returns null on zero / negative amount', () => {
    expect(proposeAuditFee({ amount: 0, closingDate: '2025-12-31' })).toBeNull()
  })
})

describe('proposeManualPrepaid', () => {
  it('enforces 17xx prepaid account range', () => {
    expect(() =>
      proposeManualPrepaid({
        amount: 1000,
        expenseAccount: '6310',
        prepaidAccount: '1810', // not in 17xx
        description: 'x',
        closingDate: '2025-12-31',
      }),
    ).toThrow(/17xx/)
  })

  it('emits balanced 17xx / cost-account entry that reverses Jan 1', () => {
    const r = proposeManualPrepaid({
      amount: 12_000,
      expenseAccount: '6310',
      prepaidAccount: '1730',
      description: 'Försäkring 2026',
      closingDate: '2025-12-31',
    })
    expect(r).not.toBeNull()
    expect(r!.lines[0].account_number).toBe('1730')
    expect(r!.lines[0].debit_amount).toBe(12_000)
    expect(r!.lines[1].account_number).toBe('6310')
    expect(r!.lines[1].credit_amount).toBe(12_000)
    expect(r!.reverses_on).toBe('2026-01-01')
  })
})

describe('proposeManualAccrued', () => {
  it('enforces 29xx accrued account range', () => {
    expect(() =>
      proposeManualAccrued({
        amount: 1000,
        expenseAccount: '5010',
        accruedAccount: '1990', // not in 29xx
        description: 'x',
        closingDate: '2025-12-31',
      }),
    ).toThrow(/29xx/)
  })

  it('emits balanced entry that reverses Jan 1', () => {
    const r = proposeManualAccrued({
      amount: 5_000,
      expenseAccount: '5010',
      accruedAccount: '2990',
      description: 'Hyra dec',
      closingDate: '2025-12-31',
    })
    expect(r).not.toBeNull()
    expect(r!.lines[0].account_number).toBe('5010')
    expect(r!.lines[1].account_number).toBe('2990')
    expect(r!.reverses_on).toBe('2026-01-01')
  })
})

describe('proposeRevenueDeferral', () => {
  it('debits the revenue account and credits the 29xx deferred account', () => {
    const r = proposeRevenueDeferral({
      amount: 24_000,
      revenueAccount: '3001',
      deferredAccount: '2970',
      description: 'Årsabonnemang 2026',
      closingDate: '2025-12-31',
    })
    expect(r).not.toBeNull()
    expect(r!.lines[0].account_number).toBe('3001')
    expect(r!.lines[0].debit_amount).toBe(24_000)
    expect(r!.lines[1].account_number).toBe('2970')
    expect(r!.lines[1].credit_amount).toBe(24_000)
    expect(r!.reverses_on).toBe('2026-01-01')
    expect(r!.label).toContain('Förutbetald intäkt')
  })

  it('enforces 29xx range on deferredAccount', () => {
    expect(() =>
      proposeRevenueDeferral({
        amount: 1000,
        revenueAccount: '3001',
        deferredAccount: '1710', // wrong range
        description: 'x',
        closingDate: '2025-12-31',
      }),
    ).toThrow(/29xx/)
  })
})

describe('proposeAccruedInterest', () => {
  it('emits an accrued-interest entry with the right label', () => {
    const r = proposeAccruedInterest({
      amount: 4_500,
      expenseAccount: '8410',
      accruedAccount: '2960',
      description: 'Banklån Q4',
      closingDate: '2025-12-31',
    })
    expect(r).not.toBeNull()
    expect(r!.lines[0].account_number).toBe('8410')
    expect(r!.lines[1].account_number).toBe('2960')
    expect(r!.label).toBe('Upplupen ränta: Banklån Q4')
    expect(r!.reverses_on).toBe('2026-01-01')
  })
})

describe('proposeAccruedUtility', () => {
  it('emits an accrued-utility entry with the right label', () => {
    const r = proposeAccruedUtility({
      amount: 2_300,
      expenseAccount: '5020',
      accruedAccount: '2990',
      description: 'El december',
      closingDate: '2025-12-31',
    })
    expect(r).not.toBeNull()
    expect(r!.lines[0].account_number).toBe('5020')
    expect(r!.lines[1].account_number).toBe('2990')
    expect(r!.label).toBe('Upplupen förbrukning: El december')
    expect(r!.reverses_on).toBe('2026-01-01')
  })
})
