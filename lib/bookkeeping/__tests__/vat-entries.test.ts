import { describe, it, expect } from 'vitest'
import {
  getVatRate,
  generateSalesVatLines,
  generateReverseChargeLines,
  generateInputVatLine,
  extractNetAmount,
  extractVatAmount,
} from '../vat-entries'

describe('getVatRate', () => {
  it('returns 0.25 for standard_25', () => {
    expect(getVatRate('standard_25')).toBe(0.25)
  })

  it('returns 0.12 for reduced_12', () => {
    expect(getVatRate('reduced_12')).toBe(0.12)
  })

  it('returns 0.06 for reduced_6', () => {
    expect(getVatRate('reduced_6')).toBe(0.06)
  })

  it('returns 0 for reverse_charge', () => {
    expect(getVatRate('reverse_charge')).toBe(0)
  })

  it('returns 0 for export', () => {
    expect(getVatRate('export')).toBe(0)
  })

  it('returns 0 for exempt', () => {
    expect(getVatRate('exempt')).toBe(0)
  })
})

describe('generateSalesVatLines', () => {
  it('credits 2611 (Utgående moms 25%) at standard rate', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'standard_25',
      baseAmount: 1000,
      direction: 'sales',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].account_number).toBe('2611')
    expect(lines[0].debit_amount).toBe(0)
    expect(lines[0].credit_amount).toBe(250)
  })

  it('credits 2621 (Utgående moms 12%) at reduced rate', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'reduced_12',
      baseAmount: 1000,
      direction: 'sales',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].account_number).toBe('2621')
    expect(lines[0].credit_amount).toBe(120)
  })

  it('credits 2631 (Utgående moms 6%) at reduced rate', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'reduced_6',
      baseAmount: 1000,
      direction: 'sales',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].account_number).toBe('2631')
    expect(lines[0].credit_amount).toBe(60)
  })

  it('returns empty array for reverse_charge (no domestic VAT line)', () => {
    expect(
      generateSalesVatLines({
        vatTreatment: 'reverse_charge',
        baseAmount: 1000,
        direction: 'sales',
      })
    ).toEqual([])
  })

  it('returns empty array for export', () => {
    expect(
      generateSalesVatLines({
        vatTreatment: 'export',
        baseAmount: 1000,
        direction: 'sales',
      })
    ).toEqual([])
  })

  it('returns empty array for exempt', () => {
    expect(
      generateSalesVatLines({
        vatTreatment: 'exempt',
        baseAmount: 1000,
        direction: 'sales',
      })
    ).toEqual([])
  })

  it('rounds VAT to 2 decimals (333.33 * 0.25 = 83.3325 → 83.33)', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'standard_25',
      baseAmount: 333.33,
      direction: 'sales',
    })
    expect(lines[0].credit_amount).toBe(83.33)
  })
})

describe('generateReverseChargeLines: EU/non-EU (isDomestic=false)', () => {
  it('debits 2645 and credits 2614 at 25%', () => {
    const lines = generateReverseChargeLines(1000, 0.25, false)
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[0].credit_amount).toBe(0)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].debit_amount).toBe(0)
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2645 and credits 2624 at 12%', () => {
    const lines = generateReverseChargeLines(1000, 0.12, false)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2645 and credits 2634 at 6%', () => {
    const lines = generateReverseChargeLines(1000, 0.06, false)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargeLines: domestic (isDomestic=true, ML 16 kap)', () => {
  it('debits 2647 (not 2645) and credits 2614 at 25%', () => {
    const lines = generateReverseChargeLines(1000, 0.25, true)
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2647 and credits 2624 at 12%', () => {
    const lines = generateReverseChargeLines(1000, 0.12, true)
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2647 and credits 2634 at 6%', () => {
    const lines = generateReverseChargeLines(1000, 0.06, true)
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargeLines: defaults & invariants', () => {
  it('defaults to vatRate=0.25 and isDomestic=false when omitted', () => {
    const lines = generateReverseChargeLines(1000)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[1].account_number).toBe('2614')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[1].credit_amount).toBe(250)
  })

  it('keeps debit-credit pair balanced for every rate × isDomestic combination', () => {
    for (const rate of [0.25, 0.12, 0.06]) {
      for (const isDomestic of [true, false]) {
        const lines = generateReverseChargeLines(1000, rate, isDomestic)
        expect(lines[0].debit_amount).toBe(lines[1].credit_amount)
        expect(lines[0].credit_amount).toBe(0)
        expect(lines[1].debit_amount).toBe(0)
      }
    }
  })
})

describe('generateInputVatLine', () => {
  it('debits 2641 with VAT extracted from gross at 25% (1250 → 250)', () => {
    const line = generateInputVatLine(1250, 0.25)
    expect(line).not.toBeNull()
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(250)
    expect(line!.credit_amount).toBe(0)
  })

  it('debits 2641 at 12% (1120 → 120)', () => {
    const line = generateInputVatLine(1120, 0.12)
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(120)
  })

  it('debits 2641 at 6% (1060 → 60)', () => {
    const line = generateInputVatLine(1060, 0.06)
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(60)
  })

  it('returns null at zero rate (export/exempt/reverse_charge purchases)', () => {
    expect(generateInputVatLine(1000, 0)).toBeNull()
  })

  it('defaults to vatRate=0.25 when omitted', () => {
    const line = generateInputVatLine(1250)
    expect(line!.debit_amount).toBe(250)
  })
})

describe('extractNetAmount', () => {
  it('extracts 1000 net from 1250 gross at 25%', () => {
    expect(extractNetAmount(1250, 0.25)).toBe(1000)
  })

  it('extracts 1000 net from 1120 gross at 12%', () => {
    expect(extractNetAmount(1120, 0.12)).toBe(1000)
  })

  it('extracts 1000 net from 1060 gross at 6%', () => {
    expect(extractNetAmount(1060, 0.06)).toBe(1000)
  })

  it('returns total unchanged at zero rate', () => {
    expect(extractNetAmount(1000, 0)).toBe(1000)
  })
})

describe('extractVatAmount', () => {
  it('extracts 250 VAT from 1250 gross at 25%', () => {
    expect(extractVatAmount(1250, 0.25)).toBe(250)
  })

  it('extracts 120 VAT from 1120 gross at 12%', () => {
    expect(extractVatAmount(1120, 0.12)).toBe(120)
  })

  it('extracts 60 VAT from 1060 gross at 6%', () => {
    expect(extractVatAmount(1060, 0.06)).toBe(60)
  })

  it('returns 0 at zero rate', () => {
    expect(extractVatAmount(1000, 0)).toBe(0)
  })
})

describe('extractNetAmount + extractVatAmount round-trip', () => {
  it.each([
    [1250, 0.25],
    [1120, 0.12],
    [1060, 0.06],
  ])('reconstructs total %s from net + vat at rate %s', (total, rate) => {
    const net = extractNetAmount(total, rate)
    const vat = extractVatAmount(total, rate)
    expect(net + vat).toBe(total)
  })
})
