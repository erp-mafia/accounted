import { describe, it, expect } from 'vitest'
import { FX_GAIN_ACCOUNT, FX_LOSS_ACCOUNT, fxDifferenceLine, oreRoundingLine, oreSettlementResidual } from '../ore-rounding'

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

// Parity: the kursdiff leg was hand-built in six generators (invoice and
// supplier-invoice payments, the payment plan, the payment dialog proposal,
// the currency revaluation and the batch preview). The old inline builder is
// the reference; fxDifferenceLine must give the same line for realistic
// differences (an amount converted at two rates) of both signs.
describe('fxDifferenceLine: parity with the inline legs it replaced', () => {
  function oldLeg(exchangeRateDifference: number) {
    return exchangeRateDifference > 0
      ? {
          account_number: '3960',
          debit_amount: 0,
          credit_amount: Math.round(exchangeRateDifference * 100) / 100,
          line_description: 'Valutakursvinst',
        }
      : {
          account_number: '7960',
          debit_amount: Math.round(Math.abs(exchangeRateDifference) * 100) / 100,
          credit_amount: 0,
          line_description: 'Valutakursförlust',
        }
  }

  it('gives the same leg as the old inline builder', () => {
    for (let booked = 1; booked < 3000; booked += 13.37) {
      for (const [bookedRate, paidRate] of [[11.2345, 11.2346], [10.98765, 10.9], [0.9876, 0.99], [9.87654, 9.8]]) {
        const difference = booked * paidRate - booked * bookedRate
        expect(fxDifferenceLine(difference)).toEqual(oldLeg(difference))
        expect(fxDifferenceLine(-difference)).toEqual(oldLeg(-difference))
      }
    }
  })

  it('takes the revaluation texts', () => {
    const texts = { gain: 'Orealiserade valutakursvinster', loss: 'Orealiserade valutakursförluster' }
    expect(fxDifferenceLine(12.345, texts)).toMatchObject({ account_number: FX_GAIN_ACCOUNT, credit_amount: 12.35, line_description: texts.gain })
    expect(fxDifferenceLine(-0.5, texts)).toMatchObject({ account_number: FX_LOSS_ACCOUNT, debit_amount: 0.5, line_description: texts.loss })
  })
})
