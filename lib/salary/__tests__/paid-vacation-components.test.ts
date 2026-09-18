import { describe, expect, it } from 'vitest'
import { paidVacationComponents } from '../paid-vacation-components'

describe('paid vacation component bases and rounding', () => {
  it('rounds combined daily pay and deduction before multiplication', () => {
    const result = paidVacationComponents({ days: 7, payBasis: 51230.1, supplementRate: .008, rounding: 'combined_daily' })
    expect(result.netAddition).toBe(2868.95)
    expect(paidVacationComponents({ days: 7, payBasis: 51230.1, supplementRate: .008, rounding: 'separate_daily' }).netAddition).toBe(2868.88)
  })
  it('keeps earned pay, displaced salary and supplement bases distinct during partial sickness', () => {
    const result = paidVacationComponents({ days: 6, payBasis: 48000, deductionBasis: 28800,
      supplementBasis: 28800, supplementRate: .008, rounding: 'separate_daily' })
    expect(result).toEqual({ vacationPay: 13248, salaryDeduction: 7948.8, supplement: 1382.4, netAddition: 6681.6 })
  })
  it('supports unchanged supplement basis when the historical agreement specifies it', () => {
    const result = paidVacationComponents({ days: 6, payBasis: 48000, deductionBasis: 28800,
      supplementRate: .008, rounding: 'separate_daily' })
    expect(result.netAddition).toBe(7603.2)
  })
  it('rejects non-finite and negative inputs', () => {
    for (const payBasis of [-1, NaN, Infinity]) expect(() => paidVacationComponents({ days: 5, payBasis,
      supplementRate: .008, rounding: 'separate_daily' })).toThrow()
  })
})
