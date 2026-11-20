import { describe, expect, it } from 'vitest'
import { TAX_FREE_REIMBURSEMENT_TYPES } from '@/lib/salary/account-mapping'
import { validatePayslipLineContent } from '@/lib/salary/text-rows'
import {
  MANUAL_PAYSLIP_LINE_SPECS,
  MANUAL_PAYSLIP_LINE_TYPES,
  buildManualPayslipLine,
  isManualPayslipLineType,
  manualLineCapsFromRunParams,
  storedLineItemType,
  taxableCounterpart,
  mealBenefitSchablonFromRunParams,
  mealBenefitUnit,
  MEAL_BENEFIT_KINDS,
  type ManualLineBody,
} from '@/lib/salary/manual-payslip-lines'
import { SalaryLineItemTypeSchema } from '@/lib/api/schemas'
import { isCalculatedLineType } from '@/lib/salary/calculated-line-items'
import { isBenefitItemType } from '@/lib/salary/benefit-payments'
import { isDeductionLineType, payslipLineFlags } from '@/lib/salary/line-item-roles'

const body = (r: ReturnType<typeof buildManualPayslipLine>): ManualLineBody => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)
  return r.body
}

/** The flags a row of a catalogue entry is stored with: its stored type's. */
const flagsOf = (type: keyof typeof MANUAL_PAYSLIP_LINE_SPECS) => payslipLineFlags(storedLineItemType(type))

describe('manual payslip line catalogue', () => {
  it('stores only types the line schema accepts, and never offers a derived or claim-linked one', () => {
    for (const type of MANUAL_PAYSLIP_LINE_TYPES) {
      expect(SalaryLineItemTypeSchema.safeParse(storedLineItemType(type)).success, type).toBe(true)
    }
    for (const derived of [
      'monthly_salary', 'hourly_salary', 'sick_karens', 'sick_day2_14', 'sick_day15_plus',
      'vab', 'parental_leave', 'semesterersattning', 'oresavrundning',
      'expense_reimbursement', 'benefit_car', 'net_deduction_benefit_payment',
    ]) {
      expect(isManualPayslipLineType(derived), derived).toBe(false)
    }
  })

  it('tax-free reimbursements carry no gross flag at all: the engine pays them by type into net', () => {
    for (const type of ['mileage_taxfree', 'traktamente_taxfree', 'traktamente_night_taxfree', 'traktamente_foreign_taxfree'] as const) {
      expect(TAX_FREE_REIMBURSEMENT_TYPES).toContain(storedLineItemType(type))
      expect(flagsOf(type)).toEqual({
        is_taxable: false,
        is_avgift_basis: false,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
      })
    }
  })

  it('the taxable excess of a reimbursement is taxed and avgift basis but not semestergrundande', () => {
    for (const type of ['mileage_taxable', 'traktamente_taxable', 'traktamente_foreign_taxable'] as const) {
      const f = flagsOf(type)
      expect(f.is_taxable).toBe(true)
      expect(f.is_avgift_basis).toBe(true)
      expect(f.is_vacation_basis).toBe(false)
    }
  })

  it('wages (incl. variable pay: övertid, bonus, a one-off OB amount on Övrigt) are taxed, avgift basis and semestergrundande', () => {
    // Semesterlagen: rörliga lönedelar earn semesterlön under both rules
    // (12 % on the variable part under sammalöneregeln, part of the base
    // under procentregeln), see the swedish-payroll vacation-pay reference.
    for (const type of ['bonus', 'commission', 'overtime', 'other'] as const) {
      expect(flagsOf(type)).toEqual({
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
        is_net_deduction: false,
      })
    }
  })

  it('kostförmån and övrig förmån carry the flags of the benefit row the employee derives: taxed, avgift basis, not semestergrundande (crm#1349)', () => {
    for (const type of ['benefit_meals', 'benefit_other'] as const) {
      expect(isBenefitItemType(type), type).toBe(true)
      expect(flagsOf(type), type).toEqual({
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: false,
        is_gross_deduction: false,
        is_net_deduction: false,
      })
      expect(MANUAL_PAYSLIP_LINE_SPECS[type].typedSign, type).toBeUndefined()
      expect(isDeductionLineType(storedLineItemType(type)), type).toBe(false)
    }
  })

  it('keeps the standing benefits on the employee: bilförmån, bostad, cykel and friskvård are not offered', () => {
    for (const type of ['benefit_car', 'benefit_housing', 'benefit_bike', 'benefit_wellness']) {
      expect(isManualPayslipLineType(type), type).toBe(false)
    }
  })

  it('deductions are flagged the way the recurring lines are', () => {
    expect(flagsOf('gross_deduction_other')).toEqual({
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: true,
      is_net_deduction: false,
    })
    for (const type of ['net_deduction_advance', 'net_deduction_other'] as const) {
      expect(flagsOf(type).is_net_deduction).toBe(true)
      expect(flagsOf(type).is_taxable).toBe(false)
    }
  })
})

describe('buildManualPayslipLine', () => {
  it('milersättning: quantity x unit price, tax-free, Swedish default description', () => {
    expect(body(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 12.5, unit_price: 25 }))).toEqual({
      item_type: 'mileage_taxfree',
      description: 'Milersättning (skattefri)',
      quantity: 12.5,
      unit_price: 25,
      amount: 312.5,
    })
  })

  it('traktamente: three days at the 2026 schablon', () => {
    const b = body(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 3, unit_price: 300 }))
    expect(b.amount).toBe(900)
    expect(flagsOf('traktamente_taxfree').is_taxable).toBe(false)
  })

  it('kostförmån: nine dinners at the 2026 schablon', () => {
    const b = body(buildManualPayslipLine({ item_type: 'benefit_meals', quantity: 9, unit_price: 124 }))
    expect(b.item_type).toBe('benefit_meals')
    expect(b.description).toBe('Kostförmån')
    expect(b.amount).toBe(1116)
    expect(flagsOf('benefit_meals').is_taxable).toBe(true)
  })

  it('kostförmån per meal: the meal names the default description, a typed one wins (crm#1349)', () => {
    expect(body(buildManualPayslipLine({ item_type: 'benefit_meals', quantity: 9, unit_price: 124, meal_kind: 'lunch_middag' })).description)
      .toBe('Kostförmån, lunch eller middag')
    expect(body(buildManualPayslipLine({ item_type: 'benefit_meals', quantity: 4, unit_price: 62, meal_kind: 'frukost' })).description)
      .toBe('Kostförmån, frukost')
    expect(body(buildManualPayslipLine({ item_type: 'benefit_meals', quantity: 2, unit_price: 310, meal_kind: 'heldag' })).description)
      .toBe('Kostförmån, helt fri kost')
    expect(
      body(buildManualPayslipLine({ item_type: 'benefit_meals', quantity: 3, unit_price: 124, meal_kind: 'lunch_middag', description: 'Sena middagar v. 42' })).description,
    ).toBe('Sena middagar v. 42')
    // A meal on another type is ignored.
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: 1, meal_kind: 'frukost' })).description).toBe('Bonus')
  })

  it('övrig förmån: a one-off amount, added to the tax base and not paid out', () => {
    const b = body(buildManualPayslipLine({ item_type: 'benefit_other', amount: 1500 }))
    expect(b).toMatchObject({ item_type: 'benefit_other', description: 'Övrig förmån', amount: 1500 })
  })

  it('quantity x unit price wins over a typed amount, and rounds to öre', () => {
    const b = body(buildManualPayslipLine({ item_type: 'overtime', quantity: 3, unit_price: 233.333, amount: 1 }))
    expect(b.amount).toBe(700)
  })

  it('a deduction is stored negative whatever sign was typed; an addition positive', () => {
    expect(body(buildManualPayslipLine({ item_type: 'net_deduction_advance', amount: 2000 })).amount).toBe(-2000)
    expect(body(buildManualPayslipLine({ item_type: 'net_deduction_advance', amount: -2000 })).amount).toBe(-2000)
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: -5000 })).amount).toBe(5000)
  })

  it('a correction keeps the typed sign', () => {
    expect(body(buildManualPayslipLine({ item_type: 'correction', amount: -150 })).amount).toBe(-150)
    expect(body(buildManualPayslipLine({ item_type: 'correction', amount: 150 })).amount).toBe(150)
  })

  it('keeps a typed description and falls back to the label when blank', () => {
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: 1, description: '  Q3  ' })).description).toBe('Q3')
    expect(body(buildManualPayslipLine({ item_type: 'bonus', amount: 1, description: '   ' })).description).toBe('Bonus')
  })

  it('refuses a missing amount, zero, or an unknown type', () => {
    for (const input of [
      { item_type: 'bonus' as const },
      { item_type: 'bonus' as const, amount: 0 },
      { item_type: 'bonus' as const, quantity: 0, unit_price: 25 },
      { item_type: 'bonus' as const, amount: Number.NaN },
      { item_type: 'monthly_salary' as never, amount: 1 },
    ]) {
      expect(buildManualPayslipLine(input)).toEqual({ ok: false, reason: 'no_amount' })
    }
  })

  it('omits quantity and unit price from the body when only one is given', () => {
    const b = body(buildManualPayslipLine({ item_type: 'overtime', quantity: 4, amount: 1000 }))
    expect(b.amount).toBe(1000)
    expect(b.quantity).toBe(4)
    expect('unit_price' in b).toBe(false)
  })

  describe('tax-free schablon caps (from the run year payroll config)', () => {
    const caps = { mileage_taxfree: 25, traktamente_taxfree: 300 }

    it('refuses a tax-free milersättning priced above the schablon', () => {
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 30 }, caps)).toEqual({
        ok: false,
        reason: 'above_tax_free_cap',
        cap: 25,
        unit: 'mil',
      })
      // Amount over quantity is a price too.
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, amount: 300 }, caps)).toMatchObject({
        ok: false,
        reason: 'above_tax_free_cap',
      })
    })

    it('accepts the schablon itself, below it, and a half day', () => {
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 25 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 18.5 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 2, unit_price: 150 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 1, unit_price: 300.001 }, caps).ok).toBe(false)
    })

    it('does not judge an amount without a quantity, the taxable rows, or a run without caps', () => {
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', amount: 5000 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxable', quantity: 10, unit_price: 30 }, caps).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 30 }).ok).toBe(true)
      expect(buildManualPayslipLine({ item_type: 'mileage_taxfree', quantity: 10, unit_price: 30 }, { mileage_taxfree: 0 }).ok).toBe(true)
    })
  })
})

describe('utlandstraktamente and nattraktamente (crm#1468, PH 218)', () => {
  const caps = { mileage_taxfree: 25, traktamente_taxfree: 300, traktamente_night_taxfree: 150 }

  it('stores a foreign row as a traktamente row on 7323 / 7324 with the country in the description', () => {
    expect(
      body(
        buildManualPayslipLine(
          { item_type: 'traktamente_foreign_taxfree', quantity: 3, unit_price: 600, country: ' Tyskland ', normalbelopp: 600 },
          caps,
        ),
      ),
    ).toEqual({
      item_type: 'traktamente_taxfree',
      description: 'Utlandstraktamente (skattefritt), Tyskland',
      quantity: 3,
      unit_price: 600,
      amount: 1800,
      account_number: '7323',
    })
    const excess = body(
      buildManualPayslipLine({ item_type: 'traktamente_foreign_taxable', quantity: 3, unit_price: 100, country: 'Tyskland' }, caps),
    )
    expect(excess).toMatchObject({
      item_type: 'traktamente_taxable',
      description: 'Utlandstraktamente (skattepliktigt), Tyskland',
      amount: 300,
      account_number: '7324',
    })
  })

  it('caps the tax-free foreign à-pris at the entered normalbelopp, not at the domestic 300 kr', () => {
    // The ticket: a foreign day above 300 kr was refused by the domestic cap.
    expect(
      buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', quantity: 2, unit_price: 812.5, country: 'Norge', normalbelopp: 812.5 }, caps).ok,
    ).toBe(true)
    expect(
      buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', quantity: 2, unit_price: 900, country: 'Norge', normalbelopp: 812.5 }, caps),
    ).toEqual({ ok: false, reason: 'above_tax_free_cap', cap: 812.5, unit: 'dagar' })
    // Amount over days is a price too; a reduced à-pris (meals, tremånadersregeln) passes.
    expect(
      buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', quantity: 2, amount: 2000, country: 'Norge', normalbelopp: 812.5 }, caps).ok,
    ).toBe(false)
    expect(
      buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', quantity: 2, unit_price: 568.75, country: 'Norge', normalbelopp: 812.5 }, caps).ok,
    ).toBe(true)
    // The domestic row keeps its 300 kr cap.
    expect(buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 2, unit_price: 600 }, caps)).toMatchObject({
      ok: false,
      cap: 300,
    })
  })

  it('needs the country, and the normalbelopp on the tax-free row only', () => {
    expect(buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', quantity: 1, unit_price: 500, country: '  ', normalbelopp: 500 })).toEqual({
      ok: false,
      reason: 'no_country',
    })
    for (const normalbelopp of [undefined, null, 0, -1, Number.NaN]) {
      expect(
        buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', quantity: 1, unit_price: 500, country: 'Polen', normalbelopp }),
        String(normalbelopp),
      ).toEqual({ ok: false, reason: 'no_normalbelopp' })
    }
    expect(buildManualPayslipLine({ item_type: 'traktamente_foreign_taxable', quantity: 1, unit_price: 500 })).toEqual({
      ok: false,
      reason: 'no_country',
    })
    expect(buildManualPayslipLine({ item_type: 'traktamente_foreign_taxable', amount: 500, country: 'Polen' }).ok).toBe(true)
    // An amount is still needed first.
    expect(buildManualPayslipLine({ item_type: 'traktamente_foreign_taxfree', country: 'Polen', normalbelopp: 500 })).toEqual({
      ok: false,
      reason: 'no_amount',
    })
  })

  it('keeps a typed description and lets the foreign fields alone off the domestic rows', () => {
    expect(
      body(
        buildManualPayslipLine({
          item_type: 'traktamente_foreign_taxfree',
          description: 'Mässa Berlin v. 41',
          quantity: 1,
          unit_price: 500,
          country: 'Tyskland',
          normalbelopp: 600,
        }),
      ).description,
    ).toBe('Mässa Berlin v. 41')
    const domestic = body(
      buildManualPayslipLine({ item_type: 'traktamente_taxfree', quantity: 1, unit_price: 300, country: 'Tyskland', normalbelopp: 900 }, caps),
    )
    expect(domestic.description).toBe('Traktamente (skattefritt)')
    expect('account_number' in domestic).toBe(false)
  })

  it('stores nattraktamente as a tax-free traktamente row capped per night at the year schablon', () => {
    expect(body(buildManualPayslipLine({ item_type: 'traktamente_night_taxfree', quantity: 2, unit_price: 150 }, caps))).toMatchObject({
      item_type: 'traktamente_taxfree',
      description: 'Nattraktamente (skattefritt)',
      amount: 300,
    })
    expect(buildManualPayslipLine({ item_type: 'traktamente_night_taxfree', quantity: 1, unit_price: 151 }, caps)).toEqual({
      ok: false,
      reason: 'above_tax_free_cap',
      cap: 150,
      unit: 'natter',
    })
    expect('account_number' in body(buildManualPayslipLine({ item_type: 'traktamente_night_taxfree', quantity: 1, unit_price: 150 }, caps))).toBe(false)
  })

  it('points the part above a cap at the matching taxable row', () => {
    expect(taxableCounterpart('mileage_taxfree')).toBe('mileage_taxable')
    expect(taxableCounterpart('traktamente_taxfree')).toBe('traktamente_taxable')
    expect(taxableCounterpart('traktamente_night_taxfree')).toBe('traktamente_taxable')
    expect(taxableCounterpart('traktamente_foreign_taxfree')).toBe('traktamente_foreign_taxable')
  })
})

describe('manualLineCapsFromRunParams', () => {
  it('reads the serialized payroll config in either casing, ignores junk, empty without params', () => {
    expect(manualLineCapsFromRunParams({ milersattning_egen_bil: 25, traktamente_heldag: 300 })).toEqual({
      mileage_taxfree: 25,
      traktamente_taxfree: 300,
    })
    expect(manualLineCapsFromRunParams({ milersattningEgenBil: 25, traktamenteHeldag: 290 })).toEqual({
      mileage_taxfree: 25,
      traktamente_taxfree: 290,
    })
    expect(manualLineCapsFromRunParams({ traktamenteHeldag: 300, traktamenteNatt: 150 })).toEqual({
      traktamente_taxfree: 300,
      traktamente_night_taxfree: 150,
    })
    expect(manualLineCapsFromRunParams({ traktamente_natt: 145 })).toEqual({ traktamente_night_taxfree: 145 })
    expect(manualLineCapsFromRunParams({ milersattning_egen_bil: '25', traktamente_heldag: -1 })).toEqual({})
    expect(manualLineCapsFromRunParams(null)).toEqual({})
    expect(manualLineCapsFromRunParams(undefined)).toEqual({})
  })

  it('never offers a type the calculation owns: it would vanish at the next calculation (#3185)', () => {
    for (const type of MANUAL_PAYSLIP_LINE_TYPES) {
      expect(isCalculatedLineType(type), type).toBe(false)
    }
  })
})

describe('mealBenefitSchablonFromRunParams (crm#1349)', () => {
  it('reads the kostförmån the calculation froze on the run, in either casing, with its year', () => {
    expect(mealBenefitSchablonFromRunParams({ configYear: 2026, kostformanLunch: 124, kostformanFrukost: 62, kostformanHeldag: 310 })).toEqual({
      year: 2026,
      perKind: { lunch_middag: 124, frukost: 62, heldag: 310 },
    })
    expect(mealBenefitSchablonFromRunParams({ config_year: 2025, kostforman_lunch: 122, kostforman_frukost: 61, kostforman_heldag: 305 })).toEqual({
      year: 2025,
      perKind: { lunch_middag: 122, frukost: 61, heldag: 305 },
    })
  })

  it('is empty before the first calculation and ignores junk', () => {
    expect(mealBenefitSchablonFromRunParams(null)).toEqual({ perKind: {} })
    expect(mealBenefitSchablonFromRunParams(undefined)).toEqual({ perKind: {} })
    expect(mealBenefitSchablonFromRunParams({ kostformanLunch: '124', kostformanFrukost: -1 })).toEqual({ perKind: {} })
  })

  it('counts meals, and days of helt fri kost', () => {
    expect(MEAL_BENEFIT_KINDS[0]).toBe('lunch_middag')
    expect(mealBenefitUnit('lunch_middag')).toBe('maltider')
    expect(mealBenefitUnit('frukost')).toBe('maltider')
    expect(mealBenefitUnit('heldag')).toBe('dagar')
  })
})

describe('Textrad', () => {
  it('is offered, takes only its words and carries no money and no flags', () => {
    expect(isManualPayslipLineType('text')).toBe(true)
    expect(
      body(
        buildManualPayslipLine({
          item_type: 'text',
          description: '  Lönen består av grundlön\noch personligt tillägg ',
          quantity: 2,
          unit_price: 100,
          amount: 500,
        }),
      ),
    ).toEqual({
      item_type: 'text',
      description: 'Lönen består av grundlön och personligt tillägg',
      amount: 0,
    })
  })

  it('refuses blank or over-long text instead of falling back to the label', () => {
    expect(buildManualPayslipLine({ item_type: 'text', description: '  ' })).toEqual({ ok: false, reason: 'no_text' })
    expect(buildManualPayslipLine({ item_type: 'text' })).toEqual({ ok: false, reason: 'no_text' })
    expect(buildManualPayslipLine({ item_type: 'text', description: 'x'.repeat(201) })).toEqual({
      ok: false,
      reason: 'no_text',
    })
  })
})

describe('Semester (vacation days taken, crm#1331)', () => {
  it('is offered with days as its unit, and is no calculated type', () => {
    expect(isManualPayslipLineType('vacation')).toBe(true)
    expect(isCalculatedLineType('vacation')).toBe(false)
    expect(MANUAL_PAYSLIP_LINE_SPECS.vacation).toMatchObject({ label: 'Semester', unit: 'dagar', typedSign: true })
  })

  it('its amount is gross pay, taxed and in the avgiftsunderlag, but not semestergrundande', () => {
    expect(flagsOf('vacation')).toEqual({
      is_taxable: true,
      is_avgift_basis: true,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
    })
  })

  it('the days alone: stored at 0 kr with the days and the category, the shape every door accepts', () => {
    const b = body(buildManualPayslipLine({ item_type: 'vacation', quantity: 5, vacation_category: 'saved' }))
    expect(b).toEqual({
      item_type: 'vacation',
      description: 'Semester',
      quantity: 5,
      amount: 0,
      vacation_category: 'saved',
    })
    expect(validatePayslipLineContent(b)).toBeNull()
  })

  it('a semestertillägg as days x à-pris, rounded to öre; a typed amount when there is no à-pris', () => {
    // 0,43 % of a 42 849 kr monthly salary is 184,2507 kr a day.
    const tillagg = body(buildManualPayslipLine({ item_type: 'vacation', quantity: 15, unit_price: 184.2507, amount: 1 }))
    expect(tillagg.amount).toBe(2763.76)
    expect(tillagg.unit_price).toBe(184.2507)
    expect(body(buildManualPayslipLine({ item_type: 'vacation', quantity: 5, amount: 860 })).amount).toBe(860)
  })

  it('keeps the sign typed: a semesterlöneavdrag is negative', () => {
    expect(body(buildManualPayslipLine({ item_type: 'vacation', quantity: 5, amount: -9000 })).amount).toBe(-9000)
    expect(body(buildManualPayslipLine({ item_type: 'vacation', quantity: 1, amount: -0.001 })).amount).toBe(0)
    expect(Object.is(body(buildManualPayslipLine({ item_type: 'vacation', quantity: 1, amount: -0.001 })).amount, -0)).toBe(false)
  })

  it('omits the category when none is chosen (paid by default)', () => {
    expect('vacation_category' in body(buildManualPayslipLine({ item_type: 'vacation', quantity: 2 }))).toBe(false)
  })

  it('refuses a vacation line without days, whatever the amount', () => {
    for (const input of [
      { item_type: 'vacation' as const },
      { item_type: 'vacation' as const, quantity: 0 },
      { item_type: 'vacation' as const, quantity: -3 },
      { item_type: 'vacation' as const, amount: 860 },
      { item_type: 'vacation' as const, quantity: Number.NaN, unit_price: 172 },
    ]) {
      expect(buildManualPayslipLine(input)).toEqual({ ok: false, reason: 'no_days' })
    }
  })
})
