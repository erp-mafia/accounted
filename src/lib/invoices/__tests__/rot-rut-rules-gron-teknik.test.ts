import { describe, it, expect } from 'vitest'
import {
  ARTICLE_HOUSEWORK_TYPE_VALUES,
  COMBINED_MAX,
  DEDUCTION_LINE_ERRORS,
  DEDUCTION_TYPES,
  DEDUCTION_TYPE_LABELS,
  GRON_TEKNIK_INVOICE_ERRORS,
  GRON_TEKNIK_MAX,
  GRON_TEKNIK_WORK_TYPES,
  HOUSEWORK_TYPE_VALUES,
  HUS_DEDUCTION_TYPES,
  ROT_MAX,
  ROT_PERCENT,
  RUT_MAX,
  RUT_PERCENT,
  articleDeductionPrefill,
  computeDeduction,
  computeDeductionTotalsByKind,
  computeInvoiceDeductionTotal,
  deductionCapWarnings,
  deductionKindsOf,
  deductionLineIssues,
  deductionPercent,
  deductionTypeForWorkType,
  isDeductionType,
  normalizeHouseworkType,
  parseArticleHouseworkType,
  validateDeductionLines,
  validateInvoice,
  workTypeLabel,
  type ItemForDeduction,
  type ValidateInvoiceItem,
} from '../rot-rut-rules'

/**
 * Skattereduktion för grön teknik (crm#209, #3135) next to ROT/RUT.
 *
 * Rules from Skatteverket, "Så fungerar skattereduktionen för grön teknik"
 * (företag, checked 2026-09-30): 15 % for solceller, 50 % for lagring and
 * laddningspunkt, of arbete och material including moms, at most 50 000 kr
 * per person and year on top of the ROT/RUT ceiling.
 */

const sv = (n: number): string =>
  n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const solar = (overrides: Partial<Extract<ItemForDeduction, { deduction_type: 'gron_teknik' }>> = {}): ItemForDeduction => ({
  unit_price: 10000,
  quantity: 1,
  vat_rate: 25,
  deduction_type: 'gron_teknik',
  work_type: 'INSTALLATION_SOLCELLER',
  ...overrides,
})

describe('grön teknik constants', () => {
  it('uses the verified rates, codes and ceiling', () => {
    expect(GRON_TEKNIK_MAX).toBe(50000)
    expect(GRON_TEKNIK_WORK_TYPES.map((w) => [w.code, w.percent])).toEqual([
      ['INSTALLATION_SOLCELLER', 0.15],
      ['INSTALLATION_LAGRING', 0.5],
      ['INSTALLATION_LADDPUNKT', 0.5],
    ])
    expect(DEDUCTION_TYPES).toEqual(['rot', 'rut', 'gron_teknik'])
    expect(HUS_DEDUCTION_TYPES).toEqual(['rot', 'rut'])
  })

  it('labels every kind, and ROT/RUT exactly as before', () => {
    expect(Object.keys(DEDUCTION_TYPE_LABELS).sort()).toEqual([...DEDUCTION_TYPES].sort())
    expect(DEDUCTION_TYPE_LABELS.rot.ledger).toBe('ROT-avdrag')
    expect(DEDUCTION_TYPE_LABELS.rut.ledger).toBe('RUT-avdrag')
    expect(DEDUCTION_TYPE_LABELS.gron_teknik.ledger).toBe('Skattereduktion grön teknik')
    expect(DEDUCTION_TYPE_LABELS.rot.capSubject).toBe('ROT-avdraget')
  })

  it('isDeductionType and deductionKindsOf know exactly the three kinds', () => {
    expect(isDeductionType('gron_teknik')).toBe(true)
    expect(isDeductionType('GRON_TEKNIK')).toBe(false)
    expect(isDeductionType(null)).toBe(false)
    expect(
      deductionKindsOf([{ deduction_type: 'gron_teknik' }, { deduction_type: null }, { deduction_type: 'rot' }, { deduction_type: 'x' }]),
    ).toEqual(['rot', 'gron_teknik'])
  })
})

describe('deductionPercent', () => {
  it('ROT and RUT take the kind rate whatever the work type', () => {
    expect(deductionPercent('rot', null)).toBe(ROT_PERCENT)
    expect(deductionPercent('rot', 'BYGG')).toBe(ROT_PERCENT)
    expect(deductionPercent('rot', 'INSTALLATION_LAGRING')).toBe(ROT_PERCENT)
    expect(deductionPercent('rut', 'STAD')).toBe(RUT_PERCENT)
  })

  it('grön teknik takes the installation type rate and has none without one', () => {
    expect(deductionPercent('gron_teknik', 'INSTALLATION_SOLCELLER')).toBe(0.15)
    expect(deductionPercent('gron_teknik', 'INSTALLATION_LAGRING')).toBe(0.5)
    expect(deductionPercent('gron_teknik', 'INSTALLATION_LADDPUNKT')).toBe(0.5)
    expect(deductionPercent('gron_teknik', ' INSTALLATION_LADDPUNKT ')).toBe(0.5)
    expect(deductionPercent('gron_teknik', null)).toBeNull()
    expect(deductionPercent('gron_teknik', 'BYGG')).toBeNull()
    expect(deductionPercent(null, 'INSTALLATION_SOLCELLER')).toBeNull()
  })
})

describe('computeDeduction: grön teknik on arbete och material incl. moms', () => {
  it('10 000 kr at 25 % moms: 1 875 kr for solceller, 6 250 kr for lagring and laddpunkt', () => {
    expect(computeDeduction(solar())).toBe(1875)
    expect(computeDeduction(solar({ work_type: 'INSTALLATION_LAGRING' }))).toBe(6250)
    expect(computeDeduction(solar({ work_type: 'INSTALLATION_LADDPUNKT' }))).toBe(6250)
  })

  it('deducts on the net line after a discount, and on the net when there is no moms', () => {
    // 10 000 - 10 % = 9 000, + 25 % = 11 250, 15 % = 1 687,50
    expect(computeDeduction(solar({ discount_percent: 10 }))).toBe(1687.5)
    expect(computeDeduction(solar({ vat_rate: 0 }))).toBe(1500)
  })

  it('gives 0 without a valid installation type, never another kind rate', () => {
    expect(computeDeduction(solar({ work_type: null }))).toBe(0)
    expect(computeDeduction(solar({ work_type: undefined }))).toBe(0)
    expect(computeDeduction(solar({ work_type: 'BYGG' }))).toBe(0)
    expect(computeDeduction(solar({ work_type: 'SOLCELLER' }))).toBe(0)
  })

  it('regression: ROT and RUT compute the same deduction as before, whatever the work type', () => {
    // The 2026 rates on the same 10 000 kr + 25 % moms line: ROT 30 %, RUT 50 %.
    expect(computeDeduction({ unit_price: 10000, quantity: 1, vat_rate: 25, deduction_type: 'rot' })).toBe(3750)
    expect(computeDeduction({ unit_price: 10000, quantity: 1, vat_rate: 25, deduction_type: 'rot', work_type: 'BYGG' })).toBe(3750)
    expect(
      computeDeduction({ unit_price: 10000, quantity: 1, vat_rate: 25, deduction_type: 'rot', work_type: 'INSTALLATION_SOLCELLER' }),
    ).toBe(3750)
    expect(computeDeduction({ unit_price: 10000, quantity: 1, vat_rate: 25, deduction_type: 'rut' })).toBe(6250)
    expect(computeDeduction({ unit_price: 18000, quantity: 1, vat_rate: 25, deduction_type: 'rot' })).toBe(6750)
    // Pinned from the pre-grön-teknik implementation (origin/main fbfea61a9).
    expect(computeDeduction({ unit_price: 333.33, quantity: 3, vat_rate: 25, discount_percent: 5, deduction_type: 'rut' })).toBe(
      593.75,
    )
    expect(
      computeInvoiceDeductionTotal([
        { unit_price: 10000, quantity: 1, vat_rate: 25, deduction_type: 'rot', work_type: 'EL' },
        { unit_price: 4000, quantity: 1, vat_rate: 25, deduction_type: 'rut', work_type: 'STAD' },
        { unit_price: 2000, quantity: 1, vat_rate: 25 },
      ]),
    ).toBe(6250)
  })
})

describe("Skatteverket's worked example (Sol AB, solceller)", () => {
  // "Så fungerar skattereduktionen för grön teknik" (företag, checked
  // 2026-10-01): arbetskostnad 20 000, materialkostnad 174 000 and övriga
  // kostnader 6 000 kr, all incl. 25 % moms, total 200 000 kr of which moms
  // 40 000. Skattereduktion 15 % of arbete och material incl. moms: 29 100;
  // the customer pays 170 900.
  it('gives a 29 100 kr reduction and 170 900 kr to pay', () => {
    const lines: ItemForDeduction[] = [
      solar({ unit_price: 16000 }),
      solar({ unit_price: 139200 }),
      { unit_price: 4800, quantity: 1, vat_rate: 25, deduction_type: null },
    ]
    const totalInclVat = lines.reduce((sum, line) => sum + line.unit_price * line.quantity * 1.25, 0)
    const reduction = computeInvoiceDeductionTotal(lines)
    expect(totalInclVat).toBe(200000)
    expect(reduction).toBe(29100)
    expect(totalInclVat - reduction).toBe(170900)
  })
})

describe('computeDeductionTotalsByKind', () => {
  it('keeps the ROT/RUT shape when no grön teknik line exists', () => {
    expect(computeDeductionTotalsByKind([{ unit_price: 10000, quantity: 1, deduction_type: 'rot' }])).toStrictEqual({
      rot: 3000,
      rut: 0,
    })
  })

  it('adds a grön teknik bucket of its own', () => {
    expect(
      computeDeductionTotalsByKind([
        solar(),
        solar({ work_type: 'INSTALLATION_LAGRING', unit_price: 2000 }),
        { unit_price: 1000, quantity: 1, vat_rate: 25 },
      ]),
    ).toStrictEqual({ rot: 0, rut: 0, gron_teknik: 3125 })
  })
})

describe('deductionCapWarnings: the grön teknik ceiling is its own', () => {
  const subject = 'Skattereduktionen för grön teknik'

  it('warns above 50 000 kr and not at exactly 50 000 kr', () => {
    expect(deductionCapWarnings({ rot: 0, rut: 0, gron_teknik: 50000 })).toEqual([])
    const warnings = deductionCapWarnings({ rot: 0, rut: 0, gron_teknik: 50000.01 })
    // Above the ceiling on its own: no remaining headroom can absorb it, so
    // the advice names the consequence instead of "check your headroom".
    expect(warnings).toEqual([
      `${subject} på denna faktura (${sv(50000.01)} kr) överstiger årsmaximum ${GRON_TEKNIK_MAX.toLocaleString('sv-SE')} kr. ` +
        'Skatteverket betalar inte ut mer än så per person och år, så den del som överstiger det får kunden betala.',
    ])
  })

  it('adds prior grön teknik of the year, and only grön teknik', () => {
    expect(deductionCapWarnings({ rot: 0, rut: 0, gron_teknik: 20000 }, undefined, { rot: 0, rut: 0, gron_teknik: 35000 })).toEqual([
      `${subject} på denna faktura (${sv(20000)} kr) plus tidigare skattereduktion för grön teknik i år (${sv(35000)} kr) ` +
        `överstiger årsmaximum ${GRON_TEKNIK_MAX.toLocaleString('sv-SE')} kr. Kunden behöver kontrollera sitt återstående utrymme själv.`,
    ])
    // Prior ROT/RUT does not eat into the grön teknik headroom.
    expect(deductionCapWarnings({ rot: 0, rut: 0, gron_teknik: 45000 }, undefined, { rot: 50000, rut: 25000 })).toEqual([])
  })

  it('does not consume ROT/RUT headroom: full ROT/RUT plus full grön teknik warns about nothing', () => {
    expect(deductionCapWarnings({ rot: 40000, rut: 30000, gron_teknik: 50000 })).toEqual([])
    expect(COMBINED_MAX).toBe(75000)
    expect(ROT_MAX).toBe(50000)
    expect(RUT_MAX).toBe(75000)
  })

  it('says the ceiling cannot be checked on a foreign invoice without a rate', () => {
    const warnings = deductionCapWarnings({ rot: 0, rut: 0, gron_teknik: 1000 }, { currency: 'EUR' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Skattereduktionen för grön teknik på denna faktura/)
    expect(warnings[0]).toContain('kan inte stämmas av')
  })

  it('converts a foreign grön teknik amount before comparing', () => {
    const warnings = deductionCapWarnings({ rot: 0, rut: 0, gron_teknik: 5000 }, { currency: 'EUR', exchangeRate: 11 })
    expect(warnings[0]).toContain(`${sv(5000)} EUR = ${sv(55000)} kr`)
  })

  it('leaves ROT/RUT output byte-identical whether gron_teknik is absent or zero', () => {
    for (const totals of [
      { rot: 60000, rut: 0 },
      { rot: 40000, rut: 40000 },
      { rot: 1000, rut: 80000 },
    ]) {
      expect(deductionCapWarnings({ ...totals, gron_teknik: 0 })).toEqual(deductionCapWarnings(totals))
      expect(deductionCapWarnings({ ...totals, gron_teknik: 0 }, undefined, { rot: 1, rut: 1, gron_teknik: 0 })).toEqual(
        deductionCapWarnings(totals, undefined, { rot: 1, rut: 1 }),
      )
    }
  })
})

describe('deductionLineIssues / validateDeductionLines: grön teknik', () => {
  const labour = (overrides: Partial<ValidateInvoiceItem> = {}): ValidateInvoiceItem =>
    ({ ...solar(), labor_hours: 8, ...overrides }) as ValidateInvoiceItem
  const material = (overrides: Partial<ValidateInvoiceItem> = {}): ValidateInvoiceItem =>
    ({ ...solar({ unit_price: 40000 }), labor_hours: null, ...overrides }) as ValidateInvoiceItem

  it('a material row without hours passes when a row of the same installation has hours', () => {
    expect(validateDeductionLines([labour(), material()])).toEqual([])
  })

  it('an installation type without hours on any row fails, anchored on its first row', () => {
    expect(validateDeductionLines([material(), material()])).toEqual([DEDUCTION_LINE_ERRORS.gronTeknikHoursMissing])
    expect(
      deductionLineIssues([
        { line_type: 'product', deduction_type: 'gron_teknik', work_type: 'INSTALLATION_SOLCELLER', labor_hours: 4 },
        { line_type: 'product', deduction_type: 'gron_teknik', work_type: 'INSTALLATION_LAGRING', labor_hours: null },
        { line_type: 'product', deduction_type: 'gron_teknik', work_type: 'INSTALLATION_LAGRING', labor_hours: 0 },
      ]),
    ).toEqual([{ index: 1, field: 'labor_hours', code: 'gronTeknikHoursMissing' }])
  })

  it('each installation type needs its own hours', () => {
    expect(
      validateDeductionLines([labour(), material({ work_type: 'INSTALLATION_LAGRING' } as Partial<ValidateInvoiceItem>)]),
    ).toEqual([DEDUCTION_LINE_ERRORS.gronTeknikHoursMissing])
    expect(
      validateDeductionLines([
        labour(),
        labour({ work_type: 'INSTALLATION_LAGRING' } as Partial<ValidateInvoiceItem>),
        material({ work_type: 'INSTALLATION_LAGRING' } as Partial<ValidateInvoiceItem>),
      ]),
    ).toEqual([])
  })

  it('requires a grön teknik installation type on every flagged row', () => {
    expect(validateDeductionLines([labour({ work_type: null } as Partial<ValidateInvoiceItem>)])).toEqual([
      DEDUCTION_LINE_ERRORS.gronTeknikWorkTypeMissing,
    ])
    expect(validateDeductionLines([labour({ work_type: 'BYGG' } as Partial<ValidateInvoiceItem>)])).toEqual([
      DEDUCTION_LINE_ERRORS.gronTeknikWorkTypeMismatch,
    ])
  })

  it('refuses grön teknik next to ROT or RUT on the same invoice', () => {
    const rot: ValidateInvoiceItem = { unit_price: 1000, quantity: 1, deduction_type: 'rot', work_type: 'EL', labor_hours: 2 }
    expect(validateDeductionLines([labour(), rot])).toEqual([DEDUCTION_LINE_ERRORS.gronTeknikMixed])
    expect(deductionLineIssues([rot, labour()])).toEqual([{ index: 1, field: 'deduction_type', code: 'gronTeknikMixed' }])
  })

  it('skips free-text rows', () => {
    expect(
      deductionLineIssues([{ line_type: 'text', deduction_type: 'gron_teknik', work_type: null, labor_hours: null }]),
    ).toEqual([])
  })

  it('keeps the ROT/RUT per-line rules, fields and order', () => {
    expect(
      deductionLineIssues([
        { deduction_type: 'rut', work_type: null, labor_hours: null },
        { deduction_type: 'rot', work_type: 'STAD', labor_hours: 3 },
      ]),
    ).toEqual([
      { index: 0, field: 'work_type', code: 'workTypeMissing' },
      { index: 0, field: 'labor_hours', code: 'hoursMissing' },
      { index: 1, field: 'work_type', code: 'workTypeMismatch' },
    ])
  })
})

describe('validateInvoice: grön teknik prerequisites', () => {
  const lines: ValidateInvoiceItem[] = [{ ...solar(), labor_hours: 8 } as ValidateInvoiceItem]

  it('names grön teknik when the personnummer or the property is missing', () => {
    const result = validateInvoice(lines, false, false)
    expect(result.errors).toEqual([
      GRON_TEKNIK_INVOICE_ERRORS.personnummerMissing,
      GRON_TEKNIK_INVOICE_ERRORS.propertyMissing,
    ])
  })

  it('passes with personnummer and property, and warns on the grön teknik ceiling only', () => {
    expect(validateInvoice(lines, true, true)).toEqual({ errors: [], warnings: [] })
    const big: ValidateInvoiceItem[] = [
      { unit_price: 100000, quantity: 1, vat_rate: 25, deduction_type: 'gron_teknik', work_type: 'INSTALLATION_LAGRING', labor_hours: 10 },
    ]
    const result = validateInvoice(big, true, true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^Skattereduktionen för grön teknik/)
  })

  it('keeps the ROT/RUT messages unchanged', () => {
    const rut: ValidateInvoiceItem[] = [{ unit_price: 5000, quantity: 1, deduction_type: 'rut', work_type: 'STAD', labor_hours: 4 }]
    expect(validateInvoice(rut, false, true).errors).toEqual(['Personnummer krävs för ROT/RUT-avdrag.'])
    const rot: ValidateInvoiceItem[] = [{ unit_price: 5000, quantity: 1, deduction_type: 'rot', work_type: 'BYGG', labor_hours: 4 }]
    expect(validateInvoice(rot, true, false).errors).toEqual(['Fastighetsbeteckning krävs för ROT-avdrag.'])
  })
})

describe('work types and articles', () => {
  it('maps the installation codes to grön teknik with Skatteverket labels', () => {
    expect(deductionTypeForWorkType('INSTALLATION_SOLCELLER')).toBe('gron_teknik')
    expect(deductionTypeForWorkType('INSTALLATION_LADDPUNKT')).toBe('gron_teknik')
    expect(workTypeLabel('INSTALLATION_LAGRING')).toBe('Installation av system för lagring av egenproducerad elenergi')
    expect(workTypeLabel('INSTALLATION_SOLCELLER')).toBe('Installation av solceller')
  })

  it('parses an installation code on an article, and has no bare grön teknik kind', () => {
    expect(parseArticleHouseworkType('installation_solceller')).toEqual({
      deductionType: 'gron_teknik',
      workType: 'INSTALLATION_SOLCELLER',
    })
    expect(parseArticleHouseworkType('GRON_TEKNIK')).toEqual({ deductionType: null, workType: null })
    expect(normalizeHouseworkType(' installation_laddpunkt ')).toBe('INSTALLATION_LADDPUNKT')
    expect(normalizeHouseworkType('GRON_TEKNIK')).toBeNull()
  })

  it('a goods article pre-fills grön teknik (material is in its base) but still never ROT/RUT', () => {
    expect(articleDeductionPrefill({ type: 'vara', housework_type: 'INSTALLATION_LAGRING' })).toEqual({
      deductionType: 'gron_teknik',
      workType: 'INSTALLATION_LAGRING',
    })
    expect(articleDeductionPrefill({ type: 'tjanst', housework_type: 'INSTALLATION_SOLCELLER' })).toEqual({
      deductionType: 'gron_teknik',
      workType: 'INSTALLATION_SOLCELLER',
    })
    expect(articleDeductionPrefill({ type: 'vara', housework_type: 'BYGG' })).toEqual({ deductionType: null, workType: null })
  })

  it('the article vocabulary adds the three installation codes to the husarbete one', () => {
    expect(ARTICLE_HOUSEWORK_TYPE_VALUES).toEqual([
      ...HOUSEWORK_TYPE_VALUES,
      'INSTALLATION_SOLCELLER',
      'INSTALLATION_LAGRING',
      'INSTALLATION_LADDPUNKT',
    ])
    expect(HOUSEWORK_TYPE_VALUES).not.toContain('INSTALLATION_SOLCELLER')
    for (const v of ARTICLE_HOUSEWORK_TYPE_VALUES) expect(normalizeHouseworkType(v)).toBe(v)
  })
})
