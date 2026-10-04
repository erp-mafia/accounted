import { describe, it, expect } from 'vitest'
import { oreRoundingLine, oreSettlementResidual } from '../ore-rounding'

describe('oreSettlementResidual', () => {
  it('is owed minus bank inside the one-krona band', () => {
    expect(oreSettlementResidual(1234.56, 1234)).toBe(0.56)
    expect(oreSettlementResidual(1234.56, 1235)).toBe(-0.44)
    expect(oreSettlementResidual(1000.99, 1000)).toBe(0.99)
  })

  it('is 0 for an exact settlement and for a krona or more', () => {
    expect(oreSettlementResidual(1234.56, 1234.56)).toBe(0)
    expect(oreSettlementResidual(1001, 1000)).toBe(0)
    expect(oreSettlementResidual(1000, 1001)).toBe(0)
    expect(oreSettlementResidual(1234.56, 1200)).toBe(0)
  })

  it('ignores float drift below half an öre', () => {
    expect(oreSettlementResidual(0.1 + 0.2, 0.3)).toBe(0)
  })
})

describe('oreRoundingLine', () => {
  it('customer paid short: förlust, debit 3740', () => {
    expect(oreRoundingLine(0.56, 'customer')).toEqual({
      account_number: '3740',
      debit_amount: 0.56,
      credit_amount: 0,
      line_description: 'Öresavrundning',
    })
  })

  it('customer paid over: vinst, credit 3740', () => {
    expect(oreRoundingLine(-0.44, 'customer')).toEqual({
      account_number: '3740',
      debit_amount: 0,
      credit_amount: 0.44,
      line_description: 'Öresavrundning',
    })
  })

  it('supplier paid short: vinst, credit 3740; paid over: förlust, debit 3740', () => {
    expect(oreRoundingLine(0.44, 'supplier')).toMatchObject({ debit_amount: 0, credit_amount: 0.44 })
    expect(oreRoundingLine(-0.44, 'supplier')).toMatchObject({ debit_amount: 0.44, credit_amount: 0 })
  })
})
