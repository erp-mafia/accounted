import { describe, it, expect } from 'vitest'
import {
  getVatRate,
  generateSalesVatLines,
  generateReverseChargePurchaseLines,
  generateReverseChargeBasisLines,
  costAccountReportsRcBasis,
  reverseChargeKindForSupplierType,
  reverseChargeKindRuta,
  REVERSE_CHARGE_KINDS,
  generateInputVatLine,
  extractNetAmount,
  extractVatAmount,
  type ReverseChargeKind,
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

// The fiktiv pair is private: every producer gets it from the complete set,
// so it can never be posted without the basis pair (#2919). Its first two
// lines are the fiktiv pair, the last two the basis pair.
const rc = (base: number, rate: number, kind: ReverseChargeKind, basisBase?: number) =>
  generateReverseChargePurchaseLines({ base, rate, kind, basisBase })

describe('generateReverseChargePurchaseLines: fiktiv pair, EU/non-EU (2645)', () => {
  it('debits 2645 and credits 2614 at 25%', () => {
    const lines = rc(1000, 0.25, 'eu_services')
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[0].credit_amount).toBe(0)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].debit_amount).toBe(0)
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2645 and credits 2624 at 12%', () => {
    const lines = rc(1000, 0.12, 'non_eu_services')
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2645 and credits 2634 at 6%', () => {
    const lines = rc(1000, 0.06, 'eu_goods')
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargePurchaseLines: fiktiv pair, domestic (2647, ML 16 kap)', () => {
  it('debits 2647 (not 2645) and credits 2614 at 25%', () => {
    const lines = rc(1000, 0.25, 'domestic_services')
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2647 and credits 2624 at 12%', () => {
    const lines = rc(1000, 0.12, 'domestic_services')
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2647 and credits 2634 at 6%', () => {
    const lines = rc(1000, 0.06, 'domestic_services')
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargePurchaseLines: basis pair and invariants', () => {
  it('defaults to 25 % and emits the basis pair on the whole base', () => {
    const lines = generateReverseChargePurchaseLines({ base: 1000, kind: 'eu_services' })
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4535', 1000, 0],
      ['4598', 0, 1000],
    ])
  })

  it.each([
    ['eu_goods', ['4515', '4516', '4517']],
    ['eu_services', ['4535', '4536', '4537']],
    ['non_eu_services', ['4531', '4532', '4533']],
    ['domestic_services', ['4425', '4426', '4427']],
  ] as const)('puts the %s basis on the per-rate account', (kind, accounts) => {
    ;[0.25, 0.12, 0.06].forEach((rate, i) => {
      expect(rc(1000, rate, kind)[2].account_number).toBe(accounts[i])
      expect(rc(1000, rate, kind)[3].account_number).toBe('4598')
    })
  })

  it('maps each kind to its momsdeklaration box', () => {
    expect(reverseChargeKindRuta('eu_goods')).toBe('ruta20')
    expect(reverseChargeKindRuta('eu_services')).toBe('ruta21')
    expect(reverseChargeKindRuta('non_eu_services')).toBe('ruta22')
    expect(reverseChargeKindRuta('domestic_services')).toBe('ruta24')
  })

  it('emits the basis only for basisBase: none at 0, a share when part is already on a basis account', () => {
    expect(rc(1000, 0.25, 'eu_services', 0).map((l) => l.account_number)).toEqual(['2645', '2614'])
    const partial = rc(1000, 0.25, 'eu_services', 400)
    expect(partial[0].debit_amount).toBe(250) // fiktiv moms stays on the whole base
    expect(partial[2]).toMatchObject({ account_number: '4535', debit_amount: 400 })
    expect(partial[3]).toMatchObject({ account_number: '4598', credit_amount: 400 })
  })

  it('returns nothing for a zero or negative base', () => {
    expect(rc(0, 0.25, 'eu_services')).toEqual([])
    expect(rc(-10, 0.25, 'eu_services')).toEqual([])
  })

  it('balances for every rate and kind', () => {
    for (const rate of [0.25, 0.12, 0.06]) {
      for (const kind of REVERSE_CHARGE_KINDS) {
        const lines = rc(1234.56, rate, kind)
        expect(lines).toHaveLength(4)
        const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
        const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
        expect(Math.round(debit * 100) / 100).toBe(Math.round(credit * 100) / 100)
      }
    }
  })

  it('keeps generateReverseChargeBasisLines (credit-note mirror) on the supplier-type mapping', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'eu_business')[0].account_number).toBe('4535')
    expect(generateReverseChargeBasisLines(1000, 0.25, 'non_eu_business')[0].account_number).toBe('4531')
    expect(generateReverseChargeBasisLines(1000, 0.25, 'swedish_business')[0].account_number).toBe('4425')
    expect(reverseChargeKindForSupplierType('non_eu_business')).toBe('non_eu_services')
  })
})

describe('costAccountReportsRcBasis', () => {
  it('without a chart row, treats the 44xx/45xx range as reporting the basis (pure producers)', () => {
    expect(costAccountReportsRcBasis('4535')).toBe(true)
    expect(costAccountReportsRcBasis('4538')).toBe(true)
    expect(costAccountReportsRcBasis('6540')).toBe(false)
    expect(costAccountReportsRcBasis('5420')).toBe(false)
  })

  it('with a chart row, follows the declaration: a configured treatment decides', () => {
    // Pattern B: a cost account configured to feed ruta 21 itself.
    expect(costAccountReportsRcBasis('6540', 'reverse_charge_eu_services')).toBe(true)
    expect(costAccountReportsRcBasis('4056', 'reverse_charge_eu_goods')).toBe(true)
    expect(costAccountReportsRcBasis('4400', 'reverse_charge_domestic')).toBe(true)
    // Configured, but not to a basis box: the pair is still needed.
    expect(costAccountReportsRcBasis('4535', 'standard_25')).toBe(false)
    expect(costAccountReportsRcBasis('6540', 'standard_25')).toBe(false)
  })

  it('with an unconfigured chart row, only the static BAS basis accounts report', () => {
    expect(costAccountReportsRcBasis('4535', null)).toBe(true)
    expect(costAccountReportsRcBasis('4531', null)).toBe(true)
    // A company-numbered 45xx without a treatment feeds no box at all.
    expect(costAccountReportsRcBasis('4538', null)).toBe(false)
    expect(costAccountReportsRcBasis('6540', null)).toBe(false)
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
