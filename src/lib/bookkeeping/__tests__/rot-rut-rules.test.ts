import { describe, it, expect } from 'vitest'
import {
  ROT_PERCENT,
  RUT_PERCENT,
  ROT_MAX,
  RUT_MAX,
  computeDeduction,
  computeInvoiceDeductionTotal,
  computeDeductionTotalsByKind,
  computeLineDeductions,
  validateInvoice,
  deductionSekConverter,
  deductionToSek,
  deductionTypeForWorkType,
  parseArticleHouseworkType,
  articleDeductionPrefill,
  normalizeHouseworkType,
  workTypeLabel,
  HOUSEWORK_TYPE_VALUES,
  ROT_WORK_TYPES,
  RUT_WORK_TYPES,

  validateDeductionLines,
  deductionCapWarnings,
  COMBINED_MAX,
  DEDUCTION_LINE_ERRORS,
  type ItemForDeduction,
  type ValidateInvoiceItem,
} from '../rot-rut-rules'

// Mirrors the warning-text formatter in rot-rut-rules.ts, so the expected
// strings stay correct regardless of which group separator the ICU build picks.
const sv = (n: number): string =>
  n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

describe('rot-rut-rules: constants', () => {
  it('uses the 2026 statutory rates', () => {
    expect(ROT_PERCENT).toBe(0.30)
    expect(RUT_PERCENT).toBe(0.50)
    expect(ROT_MAX).toBe(50000)
    expect(RUT_MAX).toBe(75000)
  })
})

describe('computeDeduction', () => {
  it('standard ROT: 10 000 kr labor → 3 000 kr deduction', () => {
    const item: ItemForDeduction = {
      unit_price: 10000,
      quantity: 1,
      deduction_type: 'rot',
    }
    expect(computeDeduction(item)).toBe(3000)
  })

  it('standard RUT: 5 000 kr labor → 2 500 kr deduction', () => {
    const item: ItemForDeduction = {
      unit_price: 5000,
      quantity: 1,
      deduction_type: 'rut',
    }
    expect(computeDeduction(item)).toBe(2500)
  })

  it('no deduction_type → 0', () => {
    const item: ItemForDeduction = {
      unit_price: 10000,
      quantity: 1,
    }
    expect(computeDeduction(item)).toBe(0)
  })

  it('null deduction_type → 0', () => {
    const item: ItemForDeduction = {
      unit_price: 10000,
      quantity: 1,
      deduction_type: null,
    }
    expect(computeDeduction(item)).toBe(0)
  })

  it('negative or zero amount → 0', () => {
    expect(computeDeduction({ unit_price: 0, quantity: 1, deduction_type: 'rot' })).toBe(0)
    expect(computeDeduction({ unit_price: -100, quantity: 1, deduction_type: 'rut' })).toBe(0)
  })

  it('quantity > 1 with ROT', () => {
    const item: ItemForDeduction = {
      unit_price: 500,
      quantity: 20, // 10 000 total
      deduction_type: 'rot',
    }
    expect(computeDeduction(item)).toBe(3000)
  })

  it('rounds to two decimals', () => {
    const item: ItemForDeduction = {
      unit_price: 333.33,
      quantity: 1,
      deduction_type: 'rut', // 333.33 * 0.5 = 166.665 → 166.67 (banker's rounding off)
    }
    expect(computeDeduction(item)).toBe(166.67)
  })

  it('caps at line total even if percent goes off (defensive)', () => {
    // The percent is < 1.0 so this is hypothetical, but the cap is part
    // of the contract: assert it via a synthetic case where unit_price ×
    // quantity happens to be tiny but the rounding step could overshoot.
    const item: ItemForDeduction = {
      unit_price: 0.01,
      quantity: 1,
      deduction_type: 'rut',
    }
    // 0.01 * 0.5 = 0.005 → rounds to 0.01 = line_total. OK, capped.
    expect(computeDeduction(item)).toBe(0.01)
  })
})

describe('computeDeduction: base is labor cost INCLUDING VAT (HUSFL 6-9 §§)', () => {
  it('Skatteverket worked example: 18 000 kr arbetskostnad @ 25% = 22 500 inkl. moms, ROT 30% = 6 750', () => {
    const item: ItemForDeduction = {
      unit_price: 18000,
      quantity: 1,
      deduction_type: 'rot',
      vat_rate: 25,
    }
    expect(computeDeduction(item)).toBe(6750)
  })

  it('RUT 50% of labor incl. moms: 1 000 kr @ 25% = 1 250 → 625', () => {
    const item: ItemForDeduction = {
      unit_price: 1000,
      quantity: 1,
      deduction_type: 'rut',
      vat_rate: 25,
    }
    expect(computeDeduction(item)).toBe(625)
  })

  it('respects the line rate: 1 000 kr @ 12% = 1 120 → ROT 336', () => {
    const item: ItemForDeduction = {
      unit_price: 1000,
      quantity: 1,
      deduction_type: 'rot',
      vat_rate: 12,
    }
    expect(computeDeduction(item)).toBe(336)
  })

  it('vat_rate 0, null and undefined all mean momsfri labor (base = line total)', () => {
    const base: ItemForDeduction = { unit_price: 10000, quantity: 1, deduction_type: 'rot' }
    expect(computeDeduction({ ...base, vat_rate: 0 })).toBe(3000)
    expect(computeDeduction({ ...base, vat_rate: null })).toBe(3000)
    expect(computeDeduction(base)).toBe(3000)
  })

  it('reproduces the stored per-line vat_amount rounding before applying the percent', () => {
    // 333.33 @ 25%: stored vat_amount = round2(83.3325) = 83.33, so the base
    // is 416.66 (not 416.6625) and RUT 50% = 208.33.
    const item: ItemForDeduction = {
      unit_price: 333.33,
      quantity: 1,
      deduction_type: 'rut',
      vat_rate: 25,
    }
    expect(computeDeduction(item)).toBe(208.33)
  })

  it('quantity > 1 with VAT: 20 × 500 kr @ 25% = 12 500 inkl. → ROT 3 750', () => {
    const item: ItemForDeduction = {
      unit_price: 500,
      quantity: 20,
      deduction_type: 'rot',
      vat_rate: 25,
    }
    expect(computeDeduction(item)).toBe(3750)
  })
})

describe('computeDeduction: an exact half öre rounds up, whatever the float product says (#90)', () => {
  // In integer öre: a share is exact, and a remainder of 50 hundredths of an
  // öre is a tie that rounds up (roundOre's rule, as computeLineVat's moms).
  const halfUp = (oreTimesPercent: number): number => Math.floor((oreTimesPercent + 50) / 100)

  it('ROT 30 %: 1 000,28 kr + 25 % moms = 1 250,35 kr deducts 375,11, not 375,10', () => {
    // 1250.35 * 0.3 is 375.10499999999996 in binary floating point.
    expect(computeDeduction({ unit_price: 1000.28, quantity: 1, deduction_type: 'rot', vat_rate: 25 })).toBe(375.11)
  })

  it('RUT 50 %: 1 000,28 kr + 25 % moms = 1 250,35 kr deducts 625,18, not 625,17', () => {
    expect(computeDeduction({ unit_price: 1000.28, quantity: 1, deduction_type: 'rut', vat_rate: 25 })).toBe(625.18)
  })

  it('keeps that öre on a foreign-currency invoice, where the line amounts are the claim', () => {
    const rot: ItemForDeduction = { unit_price: 1000.28, quantity: 1, deduction_type: 'rot', vat_rate: 25 }
    expect(computeLineDeductions([rot], { currency: 'EUR' })).toEqual([375.11])
  })

  it('a SEK claim follows the öre-rounded line: 640,995 kr becomes 641,00 and claims 641 kr', () => {
    // 1 025,59 + 256,40 moms = 1 281,99 kr; RUT 50 % is exactly 640,995.
    // The file check still holds: PrisForArbete 1 282, begärt 641, betalt 641.
    const rut: ItemForDeduction = { unit_price: 1025.59, quantity: 1, deduction_type: 'rut', vat_rate: 25 }
    expect(computeDeduction(rut)).toBe(641)
    expect(computeLineDeductions([rut], { currency: 'SEK' })).toEqual([641])
  })

  it('equals the exact share on every öre amount up to 200 kr, with and without moms', () => {
    const mismatches: string[] = []
    for (let netOre = 1; netOre <= 20_000; netOre++) {
      for (const vatRate of [0, 25]) {
        const inclVatOre = netOre + halfUp(netOre * vatRate)
        for (const [deductionType, percent] of [['rot', 30], ['rut', 50]] as const) {
          const got = computeDeduction({ unit_price: netOre / 100, quantity: 1, deduction_type: deductionType, vat_rate: vatRate })
          if (got !== halfUp(inclVatOre * percent) / 100) mismatches.push(`${deductionType} ${netOre / 100} @ ${vatRate}: ${got}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('computeInvoiceDeductionTotal', () => {
  it('sums on the inkl.-moms base when rates are present', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 18000, quantity: 1, deduction_type: 'rot', vat_rate: 25 }, // 6 750
      { unit_price: 1000, quantity: 1, deduction_type: 'rut', vat_rate: 25 }, // 625
      { unit_price: 2000, quantity: 1, vat_rate: 25 }, // not flagged
    ]
    expect(computeInvoiceDeductionTotal(items, { currency: 'SEK' })).toBe(7375)
  })

  it('mixed: ROT line + non-eligible line: only ROT generates deduction', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' },
      { unit_price: 2000, quantity: 1 }, // not flagged
    ]
    expect(computeInvoiceDeductionTotal(items, { currency: 'SEK' })).toBe(3000)
  })

  it('mixed ROT + RUT lines sum independently', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' }, // 3 000
      { unit_price: 4000, quantity: 1, deduction_type: 'rut' }, // 2 000
    ]
    expect(computeInvoiceDeductionTotal(items, { currency: 'SEK' })).toBe(5000)
  })

  it('all non-eligible → 0', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 1000, quantity: 1 },
      { unit_price: 2000, quantity: 1 },
    ]
    expect(computeInvoiceDeductionTotal(items, { currency: 'SEK' })).toBe(0)
  })
})

describe('computeLineDeductions (whole kronor per claim, as Skatteverket pays)', () => {
  // 670 kr + 25 % moms = 837,50; RUT 50 % = 418,75 per line.
  const rut670: ItemForDeduction = { unit_price: 670, quantity: 1, deduction_type: 'rut', vat_rate: 25 }

  it('a RUT invoice of 837,50 claims 418 kr, so Att betala is 838 - 418 = 420', () => {
    expect(computeDeduction(rut670)).toBe(418.75)
    expect(computeLineDeductions([rut670], { currency: 'SEK' })).toEqual([418])
    expect(computeInvoiceDeductionTotal([rut670], { currency: 'SEK' })).toBe(418)
  })

  it('takes the öre off the largest line, so the lines add up to the claim', () => {
    const items: ItemForDeduction[] = [
      rut670, // 418,75
      { unit_price: 100, quantity: 1, deduction_type: 'rut', vat_rate: 25 }, // 62,50
    ]
    expect(computeLineDeductions(items, { currency: 'SEK' })).toEqual([418.5, 62.5])
    expect(computeInvoiceDeductionTotal(items, { currency: 'SEK' })).toBe(481)
  })

  it('spreads the öre over several lines when the largest is too small to take them all', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 0.8, quantity: 1, deduction_type: 'rut', vat_rate: 25 }, // 0,50
      { unit_price: 0.4, quantity: 1, deduction_type: 'rut', vat_rate: 25 }, // 0,25
    ]
    // 0,75 kr claims 0 kr: every line ends at 0, none below.
    expect(computeLineDeductions(items, { currency: 'SEK' })).toEqual([0, 0])
  })

  it('rounds ROT and RUT as separate claims and leaves other lines at 0', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 1001, quantity: 1, deduction_type: 'rot', vat_rate: 25 }, // 375,375 -> 375,38
      rut670,
      { unit_price: 2000, quantity: 1, vat_rate: 25 },
    ]
    expect(computeLineDeductions(items, { currency: 'SEK' })).toEqual([375, 418, 0])
  })

  it('keeps a whole-krona deduction as it is', () => {
    const items: ItemForDeduction[] = [{ unit_price: 10000, quantity: 1, deduction_type: 'rot', vat_rate: 25 }]
    expect(computeLineDeductions(items, { currency: 'SEK' })).toEqual([3750])
  })

  it('keeps the öre on a foreign-currency invoice (its claim is converted per line)', () => {
    expect(computeLineDeductions([rut670], { currency: 'EUR' })).toEqual([418.75])
  })

  it('grön teknik: per installation type, capped at its rate of the whole-krona cost', () => {
    // 810,72 + 25 % moms = 1 013,40 kr; 15 % = 152,01. The claim takes 15 %
    // of the kostnad rounded to 1 013 kr = 151,95, so it requests 151.
    const solar: ItemForDeduction = {
      unit_price: 810.72,
      quantity: 1,
      vat_rate: 25,
      deduction_type: 'gron_teknik',
      work_type: 'INSTALLATION_SOLCELLER',
    }
    const charger: ItemForDeduction = {
      unit_price: 670,
      quantity: 1,
      vat_rate: 25,
      deduction_type: 'gron_teknik',
      work_type: 'INSTALLATION_LADDPUNKT',
    }
    expect(computeDeduction(solar)).toBe(152.01)
    expect(computeLineDeductions([solar, charger], { currency: 'SEK' })).toEqual([151, 418])
  })
})

describe('computeDeductionTotalsByKind', () => {
  it('separates ROT and RUT', () => {
    const items: ItemForDeduction[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' }, // 3 000
      { unit_price: 4000, quantity: 1, deduction_type: 'rut' }, // 2 000
      { unit_price: 2000, quantity: 1, deduction_type: 'rot' }, // 600
    ]
    expect(computeDeductionTotalsByKind(items)).toEqual({ rot: 3600, rut: 2000 })
  })
})

describe('deductionSekConverter / deductionToSek', () => {
  it('SEK (or no context) is an identity conversion', () => {
    expect(deductionToSek(3000)).toBe(3000)
    expect(deductionToSek(3000, { currency: 'SEK' })).toBe(3000)
    expect(deductionToSek(3000, { currency: null })).toBe(3000)
    expect(deductionToSek(3000, { currency: 'sek', exchangeRate: 99 })).toBe(3000)
  })

  it('converts with the booking rate, öre-rounded like the 1513 debit', () => {
    expect(deductionToSek(625, { currency: 'EUR', exchangeRate: 11.4 })).toBe(7125)
    expect(deductionToSek(2083.33, { currency: 'EUR', exchangeRate: 11.4 })).toBe(23749.96)
    expect(deductionToSek(100, { currency: 'eur', exchangeRate: 11.4 })).toBe(1140)
  })

  it('returns null for a foreign currency with no usable rate', () => {
    expect(deductionToSek(625, { currency: 'EUR' })).toBeNull()
    expect(deductionToSek(625, { currency: 'EUR', exchangeRate: null })).toBeNull()
    expect(deductionToSek(625, { currency: 'EUR', exchangeRate: 0 })).toBeNull()
    expect(deductionToSek(625, { currency: 'EUR', exchangeRate: -1 })).toBeNull()
    expect(deductionToSek(625, { currency: 'EUR', exchangeRate: Number.NaN })).toBeNull()
    expect(deductionSekConverter({ currency: 'EUR' })).toBeNull()
  })
})

describe('validateInvoice', () => {
  it('errors when ROT/RUT but personnummer missing', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1, deduction_type: 'rut' },
    ]
    const result = validateInvoice(items, false, true)
    expect(result.errors).toContain('Personnummer krävs för ROT/RUT-avdrag.')
  })

  it('errors when ROT but housing_designation missing', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1, deduction_type: 'rot' },
    ]
    const result = validateInvoice(items, true, false)
    expect(result.errors).toContain('Fastighetsbeteckning krävs för ROT-avdrag.')
  })

  it('RUT without housing_designation → no error (RUT does not require it)', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1, deduction_type: 'rut', work_type: 'STAD', labor_hours: 4 },
    ]
    const result = validateInvoice(items, true, false)
    expect(result.errors).toHaveLength(0)
  })

  it('no deduction lines → no errors regardless of metadata', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 5000, quantity: 1 },
    ]
    expect(validateInvoice(items, false, false).errors).toHaveLength(0)
  })

  it('warns about ROT cap when invoice alone exceeds 50 000', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 200000, quantity: 1, deduction_type: 'rot', work_type: 'BYGG', labor_hours: 100 }, // 60 000 deduction
    ]
    const result = validateInvoice(items, true, true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toMatch(/ROT/)
    expect(result.warnings[0]).toMatch(/50/)
  })

  it('warns about RUT cap when invoice alone exceeds 75 000', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 200000, quantity: 1, deduction_type: 'rut' }, // 100 000 deduction
    ]
    const result = validateInvoice(items, true, true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toMatch(/RUT/)
    expect(result.warnings[0]).toMatch(/75/)
  })

  it('no warning when total under cap', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 10000, quantity: 1, deduction_type: 'rot' }, // 3 000: well under cap
    ]
    const result = validateInvoice(items, true, true)
    expect(result.warnings).toHaveLength(0)
  })

  it('SEK cap warning wording is unchanged', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 200000, quantity: 1, deduction_type: 'rot' }, // 60 000 deduction
    ]
    const expected =
      `ROT-avdraget på denna faktura (${sv(60000)} kr) överstiger årsmaximum ${ROT_MAX.toLocaleString('sv-SE')} kr. ` +
      'Kunden behöver kontrollera sitt återstående utrymme själv.'
    expect(validateInvoice(items, true, true).warnings).toEqual([expected])
    // Passing the currency explicitly must not change a character.
    expect(validateInvoice(items, true, true, { currency: 'SEK' }).warnings).toEqual([expected])
  })
})

describe('validateInvoice: foreign currency vs the kronor ceilings', () => {
  it('warns when the SEK value breaches the cap even though the foreign figure does not', () => {
    // 6 000 EUR avdrag looks tiny next to 50 000, but is 68 400 kr.
    const items: ValidateInvoiceItem[] = [
      { unit_price: 20000, quantity: 1, deduction_type: 'rot', work_type: 'BYGG', labor_hours: 10 },
    ]
    const result = validateInvoice(items, true, true, { currency: 'EUR', exchangeRate: 11.4 })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(`${sv(6000)} EUR = ${sv(68400)} kr`)
    expect(result.warnings[0]).toContain('överstiger årsmaximum')
  })

  it('stays quiet when the SEK value is under the cap although the foreign figure is not', () => {
    // 55 000 NOK avdrag is 49 500 kr: under the 50 000 kr ceiling.
    const items: ValidateInvoiceItem[] = [
      { unit_price: 183333.33, quantity: 1, deduction_type: 'rot' },
    ]
    const result = validateInvoice(items, true, true, { currency: 'NOK', exchangeRate: 0.9 })
    expect(result.warnings).toHaveLength(0)
  })

  it('never labels a foreign amount "kr"', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 250000, quantity: 1, deduction_type: 'rut' }, // 125 000 EUR
    ]
    const result = validateInvoice(items, true, true, { currency: 'EUR', exchangeRate: 11.4 })
    expect(result.warnings[0]).toContain(`${sv(125000)} EUR`)
    expect(result.warnings[0]).not.toContain(`(${sv(125000)} kr)`)
  })

  it('says the cap could not be checked when the invoice has no rate', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 20000, quantity: 1, deduction_type: 'rot', work_type: 'BYGG', labor_hours: 10 },
    ]
    const result = validateInvoice(items, true, true, { currency: 'EUR' })
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain(`${sv(6000)} EUR`)
    expect(result.warnings[0]).toContain('kan inte stämmas av')
    expect(result.warnings[0]).toContain('saknar växelkurs')
    expect(result.warnings[0]).not.toContain('överstiger')
  })

  it('reports ROT and RUT separately on the same foreign invoice', () => {
    const items: ValidateInvoiceItem[] = [
      { unit_price: 20000, quantity: 1, deduction_type: 'rot' }, // 6 000 EUR = 68 400 kr
      { unit_price: 20000, quantity: 1, deduction_type: 'rut' }, // 10 000 EUR = 114 000 kr
    ]
    const result = validateInvoice(items, true, true, { currency: 'EUR', exchangeRate: 11.4 })
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('ROT-avdraget')
    expect(result.warnings[1]).toContain('RUT-avdraget')
  })
})

describe('deductionTypeForWorkType', () => {
  it('maps ROT codes to rot and RUT codes to rut', () => {
    expect(deductionTypeForWorkType('BYGG')).toBe('rot')
    expect(deductionTypeForWorkType('VVS')).toBe('rot')
    expect(deductionTypeForWorkType('STAD')).toBe('rut')
    // IT-tjänster moved from the rot list to rut 2026-07: the mapping must
    // follow the lists, never a hardcoded copy.
    expect(deductionTypeForWorkType('IT')).toBe('rut')
    expect(deductionTypeForWorkType('TVATT')).toBe('rut')
  })

  it('maps unknown or absent codes to null', () => {
    expect(deductionTypeForWorkType(null)).toBeNull()
    expect(deductionTypeForWorkType(undefined)).toBeNull()
    expect(deductionTypeForWorkType('')).toBeNull()
    expect(deductionTypeForWorkType('SNICKERI')).toBeNull()
  })
})

describe('parseArticleHouseworkType (articles.housework_type vocabularies)', () => {
  it('a Skatteverket code decides both kind and work type', () => {
    expect(parseArticleHouseworkType('STAD')).toEqual({ deductionType: 'rut', workType: 'STAD' })
    expect(parseArticleHouseworkType('BYGG')).toEqual({ deductionType: 'rot', workType: 'BYGG' })
    // Case-insensitive: the API stores upper-case, but older writers did not.
    expect(parseArticleHouseworkType(' malning ')).toEqual({ deductionType: 'rot', workType: 'MALNING' })
  })

  it('the bare kind (what the article form stored before it offered work types) decides the kind only', () => {
    // This is the exact prod value behind the 2026-08-17 report: picking a
    // "RUT" article pre-filled nothing because only codes were recognised.
    expect(parseArticleHouseworkType('RUT')).toEqual({ deductionType: 'rut', workType: null })
    expect(parseArticleHouseworkType('rot')).toEqual({ deductionType: 'rot', workType: null })
  })

  it('anything else is not a housework flag', () => {
    // '0'/'1' are what a boolean "Rot" CSV column produced in production.
    for (const v of ['0', '1', 'Ja', 'SNICKERI', '', null, undefined]) {
      expect(parseArticleHouseworkType(v)).toEqual({ deductionType: null, workType: null })
    }
  })
})

describe('articleDeductionPrefill (what picking an article puts on the line)', () => {
  it('a service article pre-fills its housework flag', () => {
    expect(articleDeductionPrefill({ type: 'tjanst', housework_type: 'BYGG' })).toEqual({
      deductionType: 'rot',
      workType: 'BYGG',
    })
    expect(articleDeductionPrefill({ type: 'tjanst', housework_type: 'RUT' })).toEqual({
      deductionType: 'rut',
      workType: null,
    })
  })

  it('a goods article never pre-fills ROT/RUT: the deduction is on labor only', () => {
    // Tiles or a mixer tap imported with a ROT flag: the article form cannot
    // show the flag for goods, so honouring it would put 30% ROT on material.
    for (const flag of ['ROT', 'RUT', 'EL', 'BYGG', 'STAD']) {
      expect(articleDeductionPrefill({ type: 'vara', housework_type: flag })).toEqual({
        deductionType: null,
        workType: null,
      })
    }
  })

  it('no flag means no deduction, whatever the type', () => {
    expect(articleDeductionPrefill({ type: 'tjanst', housework_type: null })).toEqual({
      deductionType: null,
      workType: null,
    })
    expect(articleDeductionPrefill({ type: 'vara', housework_type: null })).toEqual({
      deductionType: null,
      workType: null,
    })
  })

  it('an article without a known type falls back to its flag (the DB default is tjanst)', () => {
    expect(articleDeductionPrefill({ housework_type: 'STAD' })).toEqual({ deductionType: 'rut', workType: 'STAD' })
  })
})

describe('normalizeHouseworkType / HOUSEWORK_TYPE_VALUES', () => {
  it('canonicalises to the code, the bare kind, or null', () => {
    expect(normalizeHouseworkType('stad')).toBe('STAD')
    expect(normalizeHouseworkType('Rut')).toBe('RUT')
    expect(normalizeHouseworkType('1')).toBeNull()
    expect(normalizeHouseworkType('')).toBeNull()
    expect(normalizeHouseworkType(null)).toBeNull()
  })

  it('accepts exactly the two kinds plus every code in both lists', () => {
    expect(HOUSEWORK_TYPE_VALUES).toHaveLength(2 + ROT_WORK_TYPES.length + RUT_WORK_TYPES.length)
    for (const v of HOUSEWORK_TYPE_VALUES) expect(normalizeHouseworkType(v)).toBe(v)
  })
})

describe('workTypeLabel', () => {
  it('returns the Skatteverket label for known codes and null otherwise', () => {
    expect(workTypeLabel('STAD')).toBe('Städning')
    expect(workTypeLabel('VVS')).toBe('VVS-arbete')
    expect(workTypeLabel('RUT')).toBeNull()
    expect(workTypeLabel(null)).toBeNull()
  })
})

describe('validateDeductionLines (claim completeness at creation)', () => {
  it('requires an arbetstyp and hours on every deduction line, once per message', () => {
    const errors = validateDeductionLines([
      { unit_price: 500, quantity: 2, deduction_type: 'rut' },
      { unit_price: 500, quantity: 2, deduction_type: 'rot' },
    ])
    expect(errors).toEqual([DEDUCTION_LINE_ERRORS.workTypeMissing, DEDUCTION_LINE_ERRORS.hoursMissing])
  })

  it('a work type from the other list is a mismatch, not a pass', () => {
    const errors = validateDeductionLines([
      { unit_price: 500, quantity: 2, deduction_type: 'rut', work_type: 'BYGG', labor_hours: 2 },
    ])
    expect(errors).toEqual([DEDUCTION_LINE_ERRORS.workTypeMismatch])
  })

  it('schablontjänster need no hours; everything else needs hours > 0', () => {
    expect(validateDeductionLines([
      { unit_price: 500, quantity: 1, deduction_type: 'rut', work_type: 'TVATT' },
    ])).toEqual([])
    expect(validateDeductionLines([
      { unit_price: 500, quantity: 1, deduction_type: 'rut', work_type: 'STAD', labor_hours: 0 },
    ])).toEqual([DEDUCTION_LINE_ERRORS.hoursMissing])
    expect(validateDeductionLines([
      { unit_price: 500, quantity: 1, deduction_type: 'rut', work_type: 'STAD', labor_hours: 2.5 },
    ])).toEqual([])
  })

  it('non-deduction lines are ignored', () => {
    expect(validateDeductionLines([{ unit_price: 500, quantity: 1 }])).toEqual([])
  })

  it('validateInvoice folds the line errors in', () => {
    const result = validateInvoice(
      [{ unit_price: 5000, quantity: 1, deduction_type: 'rut' }],
      true,
      false,
    )
    expect(result.errors).toContain(DEDUCTION_LINE_ERRORS.workTypeMissing)
    expect(result.errors).toContain(DEDUCTION_LINE_ERRORS.hoursMissing)
  })
})

describe('deductionCapWarnings: combined ceiling and prior-year accumulation', () => {
  it('COMBINED_MAX is the shared 75 000 kr ceiling', () => {
    expect(COMBINED_MAX).toBe(75000)
  })

  it('ROT 40 000 + RUT 40 000 on one invoice: neither per-kind cap trips, the combined one does', () => {
    const warnings = deductionCapWarnings({ rot: 40000, rut: 40000 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`gemensamma årsmaximum ${COMBINED_MAX.toLocaleString('sv-SE')} kr`)
    expect(warnings[0]).toContain(`${sv(80000)} kr`)
  })

  it('a RUT breach alone does not add a redundant combined warning', () => {
    const warnings = deductionCapWarnings({ rot: 1000, rut: 80000 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^RUT-avdraget/)
  })

  it('ROT alone above 50 000 trips ROT only (combined not applicable to one kind)', () => {
    const warnings = deductionCapWarnings({ rot: 60000, rut: 0 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^ROT-avdraget/)
  })

  it('prior deductions this year push a modest invoice over the ceiling', () => {
    // 3 x 20 000 kr ROT to the same person: the third invoice is the one that breaks 50 000.
    expect(deductionCapWarnings({ rot: 20000, rut: 0 }, undefined, { rot: 40000, rut: 0 })).toEqual([
      expect.stringContaining(`plus tidigare avdrag i år (${sv(40000)} kr)`),
    ])
    expect(deductionCapWarnings({ rot: 20000, rut: 0 }, undefined, { rot: 20000, rut: 0 })).toEqual([])
    // Prior RUT + this ROT: the combined ceiling binds across kinds.
    expect(deductionCapWarnings({ rot: 20000, rut: 0 }, undefined, { rot: 0, rut: 60000 })).toEqual([
      expect.stringContaining('gemensamma årsmaximum'),
    ])
  })

  it('foreign currency without a rate says so and never fabricates a combined check', () => {
    const warnings = deductionCapWarnings({ rot: 4000, rut: 4000 }, { currency: 'EUR' })
    expect(warnings).toHaveLength(2)
    expect(warnings.every((w) => w.includes('saknar växelkurs'))).toBe(true)
  })

  it('validateInvoice forwards prior-year totals', () => {
    const result = validateInvoice(
      [{ unit_price: 20000, quantity: 1, deduction_type: 'rot', work_type: 'BYGG', labor_hours: 10 }],
      true,
      true,
      undefined,
      { rot: 48000, rut: 0 },
    )
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('plus tidigare avdrag')
  })
})
