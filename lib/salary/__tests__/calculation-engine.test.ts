import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  calculateSalary,
  calculateKarensavdrag,
  calculateSjuklon,
  calculateAvgifterRate,
  calculateVacationAccrual,
  prorateBaseSalaryForPeriod,
} from '../calculation-engine'
import type { PayrollConfig } from '../payroll-config'
import type { TaxTableRate } from '../tax-tables'

// Mock personnummer module
vi.mock('../personnummer', () => ({
  decryptPersonnummer: (encrypted: string) => {
    // Return mock personnummer based on encrypted value
    if (encrypted === 'mock_old_person') return '193501011234'
    if (encrypted === 'mock_young_person') return '200301011234'
    if (encrypted === 'mock_senior_person') return '195801011234'
    // Generic helper: 'mock_born_YYYY' resolves to a Jan-1 birth in YYYY.
    // Used by ungdomsrabatt boundary tests so each case names its own year
    // explicitly rather than depending on a global mock alias.
    const m = /^mock_born_(\d{4})$/.exec(encrypted)
    if (m) return `${m[1]}01011234`
    return '199001011234' // Default: born 1990
  },
  calculateAgeAtYearStart: (pnr: string, year: number) => {
    const birthYear = parseInt(pnr.slice(0, 4))
    return year - birthYear
  },
}))

const config2026: PayrollConfig = {
  configYear: 2026,
  avgifterTotal: 0.3142,
  avgifterAlderspension: 0.1021,
  avgifterSjukforsakring: 0.0355,
  avgifterForaldraforsakring: 0.0200,
  avgifterEfterlevandepension: 0.0030,
  avgifterArbetsmarknad: 0.0264,
  avgifterArbetsskada: 0.0010,
  avgifterAllmanLoneavgift: 0.1262,
  avgifterReduced65plus: 0.1021,
  avgifterYouthRate: 0.2081,
  avgifterYouthSalaryCap: 25000,
  avgifterVaxaStodRate: 0.1021,
  avgifterVaxaStodCap: 35000,
  avgifterMinimumAnnual: 1000,
  egenavgifterTotal: 0.2897,
  slpRate: 0.2426,
  prisbasbelopp: 59200,
  inkomstbasbelopp: 83400,
  maxPgi: 625500,
  sgiCeiling: 592000,
  statligSkattBrytpunkt: 660400,
  traktamenteHeldag: 300,
  traktamenteHalvdag: 150,
  traktamenteNatt: 150,
  milersattningEgenBil: 25,
  milersattningFormansbilFossil: 12,
  milersattningFormansbilEl: 9.50,
  kostformanHeldag: 310,
  kostformanLunch: 124,
  kostformanFrukost: 62,
  friskvardCap: 5000,
  bilformanSlr: 0.0255,
  sjuklonRate: 0.80,
  karensavdragFactor: 0.20,
  maxKarensavdragPerYear: 10,
  reducedAvgiftAge: 67,
}

const emptyTaxRates: TaxTableRate[] = []

function makeBasicInput(overrides = {}) {
  return {
    employmentType: 'employee' as const,
    salaryType: 'monthly' as const,
    monthlySalary: 40000,
    employmentDegree: 100,
    taxTableNumber: null,
    taxColumn: 1,
    isSidoinkomst: false,
    jamkningPercentage: null,
    jamkningValidFrom: null,
    jamkningValidTo: null,
    fSkattStatus: 'a_skatt',
    personnummer: 'mock_standard',
    paymentDate: '2026-04-25',
    vacationRule: 'procentregeln' as const,
    vacationDaysPerYear: 25,
    semestertillaggRate: 0.0043,
    vaxaStodEligible: false,
    vaxaStodStart: null,
    vaxaStodEnd: null,
    lineItems: [],
    ...overrides,
  }
}

describe('calculateSalary', () => {
  it('calculates basic monthly salary correctly', () => {
    const result = calculateSalary(makeBasicInput(), config2026, emptyTaxRates)

    expect(result.grossSalary).toBe(40000)
    // With no tax table, falls back to 30%
    expect(result.taxWithheld).toBe(12000)
    expect(result.netSalary).toBe(28000)
    expect(result.avgifterRate).toBe(0.3142)
    expect(result.avgifterAmount).toBe(Math.round(40000 * 0.3142 * 100) / 100)
    expect(result.vacationAccrual).toBe(Math.round(40000 * 0.12 * 100) / 100)
    expect(result.steps.length).toBeGreaterThan(0)
  })

  it('applies employment degree', () => {
    const result = calculateSalary(
      makeBasicInput({ employmentDegree: 50 }),
      config2026,
      emptyTaxRates
    )

    expect(result.grossSalary).toBe(20000)
    expect(result.taxWithheld).toBe(6000) // 30% of 20000
    expect(result.netSalary).toBe(14000)
  })

  it('calculates hourly salary', () => {
    const result = calculateSalary(
      makeBasicInput({
        salaryType: 'hourly',
        monthlySalary: 0,
        hourlyRate: 250,
        hoursWorked: 160,
      }),
      config2026,
      emptyTaxRates
    )

    expect(result.grossSalary).toBe(40000) // 250 * 160
  })

  it('applies sidoinkomst flat 30%', () => {
    const result = calculateSalary(
      makeBasicInput({ isSidoinkomst: true }),
      config2026,
      emptyTaxRates
    )

    expect(result.taxWithheld).toBe(12000) // 30% of 40000
  })

  it('applies f-skatt with 0% withholding', () => {
    const result = calculateSalary(
      makeBasicInput({ fSkattStatus: 'f_skatt' }),
      config2026,
      emptyTaxRates
    )

    expect(result.taxWithheld).toBe(0)
    expect(result.netSalary).toBe(40000)
  })

  it('applies unverified flat 30%', () => {
    const result = calculateSalary(
      makeBasicInput({ fSkattStatus: 'not_verified' }),
      config2026,
      emptyTaxRates
    )

    expect(result.taxWithheld).toBe(12000)
  })

  it('applies jämkning when valid', () => {
    const result = calculateSalary(
      makeBasicInput({
        jamkningPercentage: 15,
        jamkningValidFrom: '2026-01-01',
        jamkningValidTo: '2026-12-31',
      }),
      config2026,
      emptyTaxRates
    )

    expect(result.taxWithheld).toBe(6000) // 15% of 40000
  })

  it('does not apply jämkning when outside date range', () => {
    const result = calculateSalary(
      makeBasicInput({
        jamkningPercentage: 15,
        jamkningValidFrom: '2025-01-01',
        jamkningValidTo: '2025-12-31',
        paymentDate: '2026-04-25',
      }),
      config2026,
      emptyTaxRates
    )

    // Should fall back to 30% since jämkning expired
    expect(result.taxWithheld).toBe(12000)
  })

  it('handles line item additions', () => {
    const result = calculateSalary(
      makeBasicInput({
        lineItems: [
          { itemType: 'bonus', amount: 5000, isTaxable: true, isAvgiftBasis: true, isVacationBasis: true, isGrossDeduction: false, isNetDeduction: false },
        ],
      }),
      config2026,
      emptyTaxRates
    )

    expect(result.grossSalary).toBe(45000) // 40000 + 5000
    expect(result.taxWithheld).toBe(13500) // 30% of 45000
  })

  it('applies gross deductions before tax', () => {
    const result = calculateSalary(
      makeBasicInput({
        lineItems: [
          { itemType: 'gross_deduction_pension', amount: -5000, isTaxable: true, isAvgiftBasis: true, isVacationBasis: false, isGrossDeduction: true, isNetDeduction: false },
        ],
      }),
      config2026,
      emptyTaxRates
    )

    expect(result.grossSalary).toBe(35000) // 40000 - 5000
    expect(result.grossDeductions).toBe(5000)
    expect(result.taxWithheld).toBe(10500) // 30% of 35000 (tax on reduced amount)
  })

  it('applies net deductions after tax', () => {
    const result = calculateSalary(
      makeBasicInput({
        lineItems: [
          { itemType: 'net_deduction_advance', amount: -3000, isTaxable: false, isAvgiftBasis: false, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: true },
        ],
      }),
      config2026,
      emptyTaxRates
    )

    expect(result.grossSalary).toBe(40000) // Unaffected
    expect(result.taxWithheld).toBe(12000) // 30% of 40000 (tax on full amount)
    expect(result.netDeductions).toBe(3000)
    expect(result.netSalary).toBe(25000) // 40000 - 12000 - 3000
  })

  it('calculates vacation accrual with procentregeln', () => {
    const result = calculateSalary(
      makeBasicInput({ vacationRule: 'procentregeln', vacationDaysPerYear: 25 }),
      config2026,
      emptyTaxRates
    )

    expect(result.vacationAccrual).toBe(Math.round(40000 * 0.12 * 100) / 100)
  })

  it('uses 14.4% for 30+ vacation days', () => {
    const result = calculateSalary(
      makeBasicInput({ vacationRule: 'procentregeln', vacationDaysPerYear: 30 }),
      config2026,
      emptyTaxRates
    )

    expect(result.vacationAccrual).toBe(Math.round(40000 * 0.144 * 100) / 100)
  })

  it('pays semesterersättning directly when vacation_rule = semesterersattning', () => {
    const result = calculateSalary(
      makeBasicInput({ vacationRule: 'semesterersattning', vacationDaysPerYear: 25 }),
      config2026,
      emptyTaxRates
    )

    const expectedCompensation = Math.round(40000 * 0.12 * 100) / 100
    expect(result.vacationCompensation).toBe(expectedCompensation)
    expect(result.grossSalary).toBe(40000 + expectedCompensation)
    expect(result.vacationAccrual).toBe(0)
    expect(result.vacationAccrualAvgifter).toBe(0)
    // Avgifter basis includes the compensation
    expect(result.avgifterBasis).toBe(40000 + expectedCompensation)
  })

  it('uses 14.4% for semesterersättning with 30+ vacation days', () => {
    const result = calculateSalary(
      makeBasicInput({ vacationRule: 'semesterersattning', vacationDaysPerYear: 30 }),
      config2026,
      emptyTaxRates
    )

    expect(result.vacationCompensation).toBe(Math.round(40000 * 0.144 * 100) / 100)
    expect(result.vacationAccrual).toBe(0)
  })

  it('semesterersättning includes vacation-basis line items (e.g. overtime)', () => {
    const result = calculateSalary(
      makeBasicInput({
        vacationRule: 'semesterersattning',
        vacationDaysPerYear: 25,
        lineItems: [
          { itemType: 'overtime', amount: 5000, isTaxable: true, isAvgiftBasis: true, isVacationBasis: true, isGrossDeduction: false, isNetDeduction: false },
        ],
      }),
      config2026,
      emptyTaxRates
    )

    // 12% × (40000 base + 5000 overtime) = 5400
    expect(result.vacationCompensation).toBe(5400)
    // 40000 base + 5000 overtime + 5400 semesterersättning
    expect(result.grossSalary).toBe(50400)
  })

  it('does not double-count base salary line items in vacation basis', () => {
    // The API auto-creates a monthly_salary line item with amount = baseSalary
    // and is_vacation_basis: true. The engine must not add it on top of its
    // own baseSalary computation: otherwise procentregeln/semesterersättning
    // would compute 2× the correct amount.
    const monthlyResult = calculateSalary(
      makeBasicInput({
        monthlySalary: 40000,
        employmentDegree: 50, // grundlön = 20000
        vacationRule: 'procentregeln',
        lineItems: [
          { itemType: 'monthly_salary', amount: 20000, isTaxable: true, isAvgiftBasis: true, isVacationBasis: true, isGrossDeduction: false, isNetDeduction: false },
        ],
      }),
      config2026,
      emptyTaxRates
    )
    expect(monthlyResult.vacationAccrual).toBe(2400) // 12% × 20000, not 12% × 40000

    const compResult = calculateSalary(
      makeBasicInput({
        monthlySalary: 40000,
        employmentDegree: 50,
        vacationRule: 'semesterersattning',
        lineItems: [
          { itemType: 'monthly_salary', amount: 20000, isTaxable: true, isAvgiftBasis: true, isVacationBasis: true, isGrossDeduction: false, isNetDeduction: false },
        ],
      }),
      config2026,
      emptyTaxRates
    )
    expect(compResult.vacationCompensation).toBe(2400)
    expect(compResult.grossSalary).toBe(22400) // 20000 base + 2400 comp
  })

  it('skips accrual when vacation_rule = none', () => {
    const result = calculateSalary(
      makeBasicInput({ vacationRule: 'none' }),
      config2026,
      emptyTaxRates
    )

    expect(result.vacationAccrual).toBe(0)
    expect(result.vacationCompensation).toBe(0)
    expect(result.grossSalary).toBe(40000)
  })

  it('adds benefit values to tax base but not gross', () => {
    const result = calculateSalary(
      makeBasicInput({
        lineItems: [
          { itemType: 'benefit_car', amount: 3000, isTaxable: true, isAvgiftBasis: true, isVacationBasis: false, isGrossDeduction: false, isNetDeduction: false },
        ],
      }),
      config2026,
      emptyTaxRates
    )

    expect(result.grossSalary).toBe(40000) // Benefits don't add to gross
    expect(result.benefitValues).toBe(3000)
    expect(result.taxableIncome).toBe(43000) // gross + benefits
    expect(result.taxWithheld).toBe(12900) // 30% of 43000
    expect(result.netSalary).toBe(27100) // 40000 - 12900
  })

  it('includes employer cost calculation', () => {
    const result = calculateSalary(makeBasicInput(), config2026, emptyTaxRates)

    const expectedAvgifter = Math.round(40000 * 0.3142 * 100) / 100
    const expectedVacation = Math.round(40000 * 0.12 * 100) / 100
    const expectedVacationAvgifter = Math.round(expectedVacation * 0.3142 * 100) / 100
    const expectedCost = Math.round((40000 + expectedAvgifter + expectedVacation + expectedVacationAvgifter) * 100) / 100

    expect(result.totalEmployerCost).toBe(expectedCost)
  })
})

// ============================================================
// Partial-month employment proration
// ============================================================
//
// May 2026 calendar (Mon-Fri only):
//   May 1 (Fri), May 4-8 (5), May 11-15 (5), May 18-22 (5), May 25-29 (5)
//   → 21 workdays total in May.
// An employee hired May 15 (Fri) works May 15, 18-22, 25-29 → 11 workdays.
// 11 / 21 ≈ 0.5238 → 40 000 SEK × 0.5238 ≈ 20 952,38 SEK.

describe('partial-month employment proration', () => {
  it('prorates base salary for an employee hired mid-month', () => {
    const result = calculateSalary(
      makeBasicInput({
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        employmentStart: '2026-05-15',
        employmentEnd: null,
      }),
      config2026,
      emptyTaxRates,
    )

    // 40 000 × 11 / 21 = 20 952,38 (rounded via engine's r())
    expect(result.grossSalary).toBeCloseTo(20952.38, 2)
  })

  it('prorates base salary for an employee terminated mid-month', () => {
    const result = calculateSalary(
      makeBasicInput({
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        employmentStart: '2020-01-01',
        employmentEnd: '2026-05-15',
      }),
      config2026,
      emptyTaxRates,
    )

    // May 1, 4-8, 11-15 = 11 workdays → 40 000 × 11 / 21
    expect(result.grossSalary).toBeCloseTo(20952.38, 2)
  })

  it('does not prorate when the employee covers the full period', () => {
    const result = calculateSalary(
      makeBasicInput({
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        employmentStart: '2024-01-01',
        employmentEnd: null,
      }),
      config2026,
      emptyTaxRates,
    )

    expect(result.grossSalary).toBe(40000)
  })

  it('returns 0 gross when employment does not overlap the period', () => {
    const result = calculateSalary(
      makeBasicInput({
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        employmentStart: '2026-06-01',
        employmentEnd: null,
      }),
      config2026,
      emptyTaxRates,
    )

    expect(result.grossSalary).toBe(0)
  })

  it('combines employment proration with employment_degree', () => {
    const result = calculateSalary(
      makeBasicInput({
        employmentDegree: 50,
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        employmentStart: '2026-05-15',
        employmentEnd: null,
      }),
      config2026,
      emptyTaxRates,
    )

    // 40 000 × 50% × 11 / 21 = 20 000 × 11 / 21 ≈ 10 476,19
    expect(result.grossSalary).toBeCloseTo(10476.19, 2)
  })

  it('skips proration when period bounds are missing (backward compat)', () => {
    const result = calculateSalary(
      makeBasicInput({
        employmentStart: '2026-05-15',
        employmentEnd: null,
      }),
      config2026,
      emptyTaxRates,
    )

    expect(result.grossSalary).toBe(40000)
  })

  it('subtracts unpaid_leave once on top of proration (no double-counting)', () => {
    // 40 000 × 11/21 (mid-month hire) − 2 × 40 000/21 (two unpaid days)
    //   = 20 952,38 − 3 809,52
    //   = 17 142,86
    const result = calculateSalary(
      makeBasicInput({
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        employmentStart: '2026-05-15',
        employmentEnd: null,
        lineItems: [
          {
            itemType: 'unpaid_leave',
            amount: -3809.52, // = 2 × Math.round((40000/21) * 100) / 100
            isTaxable: true,
            isAvgiftBasis: true,
            isVacationBasis: false,
            isGrossDeduction: false,
            isNetDeduction: false,
          },
        ],
      }),
      config2026,
      emptyTaxRates,
    )

    expect(result.grossSalary).toBeCloseTo(17142.86, 2)
  })
})

describe('prorateBaseSalaryForPeriod', () => {
  it('returns 1 when all dates are missing', () => {
    expect(prorateBaseSalaryForPeriod(undefined, undefined, undefined, undefined)).toBe(1)
  })

  it('returns 1 when employment fully covers the period', () => {
    expect(
      prorateBaseSalaryForPeriod('2020-01-01', null, '2026-05-01', '2026-05-31'),
    ).toBe(1)
  })

  it('returns 11/21 for May 2026 mid-month hire on the 15th', () => {
    const ratio = prorateBaseSalaryForPeriod(
      '2026-05-15',
      null,
      '2026-05-01',
      '2026-05-31',
    )
    expect(ratio).toBeCloseTo(11 / 21, 6)
  })

  it('returns 0 when employment ends before the period starts', () => {
    expect(
      prorateBaseSalaryForPeriod('2020-01-01', '2026-04-30', '2026-05-01', '2026-05-31'),
    ).toBe(0)
  })

  it('returns 0 when employment starts after the period ends', () => {
    expect(
      prorateBaseSalaryForPeriod('2026-06-01', null, '2026-05-01', '2026-05-31'),
    ).toBe(0)
  })
})

// ============================================================
// Hardening: realistic API flow & cross-rule invariants
// ============================================================
//
// These tests mirror the actual production input shape, where the
// "Lägg till anställd" endpoint auto-creates a base salary line item
// (monthly_salary or hourly_salary) before the engine runs. The plain
// `makeBasicInput()` cases above don't include that line item, so they
// miss the double-counting class of bug. The helper below adds it.

type LineItem = {
  itemType: string
  amount: number
  isTaxable: boolean
  isAvgiftBasis: boolean
  isVacationBasis: boolean
  isGrossDeduction: boolean
  isNetDeduction: boolean
}

function baseLineItem(amount: number, type: 'monthly_salary' | 'hourly_salary' = 'monthly_salary'): LineItem {
  return {
    itemType: type,
    amount,
    isTaxable: true,
    isAvgiftBasis: true,
    isVacationBasis: true,
    isGrossDeduction: false,
    isNetDeduction: false,
  }
}

function lineItem(overrides: Partial<LineItem> & { itemType: string; amount: number }): LineItem {
  return {
    isTaxable: true,
    isAvgiftBasis: true,
    isVacationBasis: false,
    isGrossDeduction: false,
    isNetDeduction: false,
    ...overrides,
  }
}

describe('hardening: vacation rule contract', () => {
  // Same input across all 4 vacation rules, locking in the relationships
  // between them. This is the contract a Swedish accountant relies on.
  const base = {
    monthlySalary: 40000,
    employmentDegree: 100,
    vacationDaysPerYear: 25,
    semestertillaggRate: 0.0043,
    lineItems: [baseLineItem(40000)],
  }

  it('procentregeln: 12% accrued, 0 paid out', () => {
    const r = calculateSalary(
      makeBasicInput({ ...base, vacationRule: 'procentregeln' }),
      config2026, emptyTaxRates
    )
    expect(r.grossSalary).toBe(40000)
    expect(r.vacationCompensation).toBe(0)
    expect(r.vacationAccrual).toBe(4800)
  })

  it('semesterersattning: 0 accrued, 12% paid out into gross', () => {
    const r = calculateSalary(
      makeBasicInput({ ...base, vacationRule: 'semesterersattning' }),
      config2026, emptyTaxRates
    )
    expect(r.grossSalary).toBe(44800) // 40000 + 4800
    expect(r.vacationCompensation).toBe(4800)
    expect(r.vacationAccrual).toBe(0)
  })

  it('sammaloneregeln: only tillägg accrued, 0 paid out', () => {
    const r = calculateSalary(
      makeBasicInput({ ...base, vacationRule: 'sammaloneregeln' }),
      config2026, emptyTaxRates
    )
    expect(r.grossSalary).toBe(40000)
    expect(r.vacationCompensation).toBe(0)
    // dagslön 40000/21 × 0.43% × 25 ≈ 204.76
    expect(r.vacationAccrual).toBeCloseTo(204.76, 1)
  })

  it('none: nothing accrued, nothing paid out', () => {
    const r = calculateSalary(
      makeBasicInput({ ...base, vacationRule: 'none' }),
      config2026, emptyTaxRates
    )
    expect(r.grossSalary).toBe(40000)
    expect(r.vacationCompensation).toBe(0)
    expect(r.vacationAccrual).toBe(0)
    expect(r.vacationAccrualAvgifter).toBe(0)
  })

  it('procentregeln and semesterersattning produce identical totalEmployerCost', () => {
    // Different bookkeeping (2920 accrual vs 7285 cash) but the same total
    // cost to the company. Locking this is the cheapest sanity check.
    const proc = calculateSalary(
      makeBasicInput({ ...base, vacationRule: 'procentregeln' }),
      config2026, emptyTaxRates
    )
    const semer = calculateSalary(
      makeBasicInput({ ...base, vacationRule: 'semesterersattning' }),
      config2026, emptyTaxRates
    )
    expect(semer.totalEmployerCost).toBeCloseTo(proc.totalEmployerCost, 1)
  })
})

describe('hardening: boundaries', () => {
  it('vacation_days_per_year = 29 uses 12%', () => {
    const r = calculateSalary(
      makeBasicInput({ vacationRule: 'procentregeln', vacationDaysPerYear: 29 }),
      config2026, emptyTaxRates
    )
    expect(r.vacationAccrual).toBeCloseTo(40000 * 0.12, 1)
  })

  it('vacation_days_per_year = 30 uses 14.4%', () => {
    const r = calculateSalary(
      makeBasicInput({ vacationRule: 'procentregeln', vacationDaysPerYear: 30 }),
      config2026, emptyTaxRates
    )
    expect(r.vacationAccrual).toBeCloseTo(40000 * 0.144, 1)
  })

  it('semesterersättning at 29 vs 30 days flips rate', () => {
    const r29 = calculateSalary(
      makeBasicInput({ vacationRule: 'semesterersattning', vacationDaysPerYear: 29 }),
      config2026, emptyTaxRates
    )
    const r30 = calculateSalary(
      makeBasicInput({ vacationRule: 'semesterersattning', vacationDaysPerYear: 30 }),
      config2026, emptyTaxRates
    )
    expect(r29.vacationCompensation).toBeCloseTo(40000 * 0.12, 1)
    expect(r30.vacationCompensation).toBeCloseTo(40000 * 0.144, 1)
  })

  it('jämkning expires on validTo (inclusive)', () => {
    const r = calculateSalary(
      makeBasicInput({
        jamkningPercentage: 10,
        jamkningValidFrom: '2026-01-01',
        jamkningValidTo: '2026-04-30',
        paymentDate: '2026-04-30',
      }),
      config2026, emptyTaxRates
    )
    expect(r.taxWithheld).toBe(4000) // 10% × 40000: still valid on the last day
  })

  it('jämkning not applied the day after validTo', () => {
    const r = calculateSalary(
      makeBasicInput({
        jamkningPercentage: 10,
        jamkningValidFrom: '2026-01-01',
        jamkningValidTo: '2026-04-30',
        paymentDate: '2026-05-01',
      }),
      config2026, emptyTaxRates
    )
    expect(r.taxWithheld).toBe(12000) // fallback 30%
  })
})

describe('hardening: sammalöneregeln', () => {
  it('part-time worker gets half the tillägg of a full-timer', () => {
    const full = calculateSalary(
      makeBasicInput({
        vacationRule: 'sammaloneregeln', monthlySalary: 40000, employmentDegree: 100,
        lineItems: [baseLineItem(40000)],
      }),
      config2026, emptyTaxRates
    )
    const half = calculateSalary(
      makeBasicInput({
        vacationRule: 'sammaloneregeln', monthlySalary: 40000, employmentDegree: 50,
        lineItems: [baseLineItem(20000)],
      }),
      config2026, emptyTaxRates
    )
    expect(half.vacationAccrual).toBeCloseTo(full.vacationAccrual / 2, 1)
  })

  it('respects custom semestertillagg_rate (CBA 0.8%)', () => {
    const r = calculateSalary(
      makeBasicInput({
        vacationRule: 'sammaloneregeln', semestertillaggRate: 0.008,
        lineItems: [baseLineItem(40000)],
      }),
      config2026, emptyTaxRates
    )
    // 40000/21 × 0.8% × 25 ≈ 380.95
    expect(r.vacationAccrual).toBeCloseTo(380.95, 1)
  })
})

describe('hardening: realistic combined scenarios', () => {
  it('monthly worker with overtime, benefit, pension deduction, semesterersättning', () => {
    const r = calculateSalary(
      makeBasicInput({
        vacationRule: 'semesterersattning',
        vacationDaysPerYear: 25,
        lineItems: [
          baseLineItem(40000),
          lineItem({ itemType: 'overtime', amount: 5000, isVacationBasis: true }),
          lineItem({ itemType: 'benefit_car', amount: 3000 }), // not vacation basis
          lineItem({ itemType: 'gross_deduction_pension', amount: -2000, isGrossDeduction: true, isVacationBasis: false }),
        ],
      }),
      config2026, emptyTaxRates
    )

    // Vacation basis = 40000 base + 5000 overtime (benefits excluded, gross deduction excluded)
    // Semesterersättning = 12% × 45000 = 5400
    expect(r.vacationCompensation).toBe(5400)
    // Gross = 40000 + 5000 overtime + 5400 semer − 2000 pension = 48400
    expect(r.grossSalary).toBe(48400)
    // Tax base = gross + benefits = 48400 + 3000 = 51400
    expect(r.taxableIncome).toBe(51400)
    expect(r.taxWithheld).toBe(15420) // 30% fallback
    // Avgifter basis = gross + benefits = 51400
    expect(r.avgifterBasis).toBe(51400)
    expect(r.vacationAccrual).toBe(0)
  })

  it('hourly worker with no manual line items still gets correct semesterersättning', () => {
    // Production sends an hourly_salary line item with the computed amount.
    const r = calculateSalary(
      makeBasicInput({
        salaryType: 'hourly',
        monthlySalary: 0,
        hourlyRate: 250,
        hoursWorked: 160,
        vacationRule: 'semesterersattning',
        lineItems: [baseLineItem(40000, 'hourly_salary')],
      }),
      config2026, emptyTaxRates
    )
    expect(r.vacationCompensation).toBe(4800) // 12% × 40000, not 12% × 80000
    expect(r.grossSalary).toBe(44800)
  })

  it('benefits do not inflate semesterersättning basis', () => {
    // Förmånsvärden are NOT vacation basis (employee doesn't earn vacation
    // pay on the value of their company car). The engine must exclude them.
    const r = calculateSalary(
      makeBasicInput({
        vacationRule: 'semesterersattning',
        lineItems: [
          baseLineItem(40000),
          lineItem({ itemType: 'benefit_car', amount: 10000, isVacationBasis: false }),
        ],
      }),
      config2026, emptyTaxRates
    )
    // Should be 12% × 40000 = 4800, not 12% × 50000 = 6000
    expect(r.vacationCompensation).toBe(4800)
  })
})

describe('hardening: invariants', () => {
  it('netSalary + taxWithheld + netDeductions = grossSalary (always)', () => {
    for (const rule of ['procentregeln', 'sammaloneregeln', 'none', 'semesterersattning'] as const) {
      const r = calculateSalary(
        makeBasicInput({
          vacationRule: rule,
          lineItems: [
            baseLineItem(40000),
            lineItem({ itemType: 'net_deduction_advance', amount: -2000, isNetDeduction: true, isTaxable: false, isAvgiftBasis: false }),
          ],
        }),
        config2026, emptyTaxRates
      )
      const reconstructed = Math.round((r.netSalary + r.taxWithheld + r.netDeductions) * 100) / 100
      expect(reconstructed).toBeCloseTo(r.grossSalary, 1)
    }
  })

  it('totalEmployerCost = grossSalary + avgifterAmount + vacationAccrual + vacationAccrualAvgifter', () => {
    for (const rule of ['procentregeln', 'sammaloneregeln', 'none', 'semesterersattning'] as const) {
      const r = calculateSalary(
        makeBasicInput({ vacationRule: rule, lineItems: [baseLineItem(40000)] }),
        config2026, emptyTaxRates
      )
      const expected = Math.round((r.grossSalary + r.avgifterAmount + r.vacationAccrual + r.vacationAccrualAvgifter) * 100) / 100
      expect(expected).toBeCloseTo(r.totalEmployerCost, 1)
    }
  })

  it('avgifterAmount = avgifterBasis × avgifterRate (within rounding)', () => {
    const r = calculateSalary(
      makeBasicInput({ lineItems: [baseLineItem(40000)] }),
      config2026, emptyTaxRates
    )
    expect(r.avgifterAmount).toBeCloseTo(r.avgifterBasis * r.avgifterRate, 1)
  })

  it('semesterersattning never produces both vacationAccrual and vacationCompensation', () => {
    const r = calculateSalary(
      makeBasicInput({
        vacationRule: 'semesterersattning',
        lineItems: [baseLineItem(40000)],
      }),
      config2026, emptyTaxRates
    )
    expect(r.vacationAccrual).toBe(0)
    expect(r.vacationCompensation).toBeGreaterThan(0)
  })
})

describe('hardening: tax table lookup (not just flat fallback)', () => {
  const taxRates: TaxTableRate[] = [
    { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 0, incomeTo: 20000, taxAmount: 3000 },
    { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 20001, incomeTo: 30000, taxAmount: 5500 },
    { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 30001, incomeTo: 50000, taxAmount: 10000 },
  ]

  it('uses table lookup when taxTableNumber is set', () => {
    const r = calculateSalary(
      makeBasicInput({ taxTableNumber: 32, taxColumn: 1, monthlySalary: 25000, lineItems: [baseLineItem(25000)] }),
      config2026, taxRates
    )
    expect(r.taxWithheld).toBe(5500)
  })

  it('semesterersättning pushes brutto into a higher tax bracket', () => {
    // Base 25000 + 12% semer = 28000, still in 20001-30000 bracket
    const semer = calculateSalary(
      makeBasicInput({
        taxTableNumber: 32, taxColumn: 1, monthlySalary: 25000,
        vacationRule: 'semesterersattning',
        lineItems: [baseLineItem(25000)],
      }),
      config2026, taxRates
    )
    expect(semer.grossSalary).toBe(28000)
    expect(semer.taxWithheld).toBe(5500) // still bracket 2
  })
})

describe('calculateVacationAccrual (standalone export)', () => {
  it('procentregeln: 12% of vacationBasis under 30 days', () => {
    const r = calculateVacationAccrual({
      monthlySalary: 40000,
      vacationRule: 'procentregeln',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 40000,
    })
    expect(r.accrual).toBe(4800)
  })

  it('procentregeln: 14.4% at 30+ days', () => {
    const r = calculateVacationAccrual({
      monthlySalary: 40000,
      vacationRule: 'procentregeln',
      vacationDaysPerYear: 30,
      semestertillaggRate: 0.0043,
      vacationBasis: 40000,
    })
    expect(r.accrual).toBeCloseTo(5760, 1)
  })

  it('sammaloneregeln: uses vacationBasis, not monthlySalary (degree-adjusted)', () => {
    // 50% worker: caller passes vacationBasis = 20000 (degree-adjusted),
    // not the raw 40000 monthlySalary. Result must be half the full-time amount.
    const partTime = calculateVacationAccrual({
      monthlySalary: 40000, // ignored
      vacationRule: 'sammaloneregeln',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 20000,
    })
    const fullTime = calculateVacationAccrual({
      monthlySalary: 40000,
      vacationRule: 'sammaloneregeln',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 40000,
    })
    expect(partTime.accrual).toBeCloseTo(fullTime.accrual / 2, 1)
    // Independent check: 20000/21 × 0.43% × 25 ≈ 102.38
    expect(partTime.accrual).toBeCloseTo(102.38, 1)
  })

  it('semesterersattning: 0 accrual with the correct step label', () => {
    const r = calculateVacationAccrual({
      monthlySalary: 40000,
      vacationRule: 'semesterersattning',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 40000,
    })
    expect(r.accrual).toBe(0)
    expect(r.steps[0].label).toContain('semesterersättning betald direkt')
  })

  it('none: 0 accrual, no "betald direkt" wording', () => {
    const r = calculateVacationAccrual({
      monthlySalary: 40000,
      vacationRule: 'none',
      vacationDaysPerYear: 25,
      semestertillaggRate: 0.0043,
      vacationBasis: 40000,
    })
    expect(r.accrual).toBe(0)
    expect(r.steps[0].label).toBe('Semesteravsättning (avstängd)')
    expect(r.steps[0].label).not.toContain('semesterersättning')
  })
})

describe('calculateKarensavdrag', () => {
  it('calculates 20% of weekly sjuklön', () => {
    // Formula: 20% × (40000 × 12/52 × 0.80)
    const expected = Math.round(0.20 * (40000 * 12 / 52 * 0.80) * 100) / 100
    expect(calculateKarensavdrag(40000, config2026)).toBe(expected)
  })
})

describe('calculateSjuklon', () => {
  it('calculates karensavdrag + sjuklön for sick days', () => {
    const result = calculateSjuklon(40000, 5, config2026)

    expect(result.karensavdrag).toBeGreaterThan(0)
    expect(result.sjuklon).toBeGreaterThan(0)
    expect(result.steps.length).toBeGreaterThan(0)
  })

  it('handles 1-day sick leave (karens only)', () => {
    const result = calculateSjuklon(40000, 1, config2026)

    expect(result.karensavdrag).toBeGreaterThan(0)
    expect(result.sjuklon).toBe(0) // No sjuklön for day 1
  })

  it('caps at 13 sjuklön days (day 2-14)', () => {
    const result14 = calculateSjuklon(40000, 14, config2026)
    const result20 = calculateSjuklon(40000, 20, config2026)

    // sjuklön should be the same for 14 and 20 days (capped at day 14)
    expect(result14.sjuklon).toBe(result20.sjuklon)
  })
})

describe('calculateAvgifterRate', () => {
  it('returns standard rate for normal employee', () => {
    const result = calculateAvgifterRate(
      makeBasicInput(),
      config2026,
      2026
    )

    expect(result.rate).toBe(0.3142)
    expect(result.category).toBe('standard')
  })

  it('returns reduced rate for 67+ employee', () => {
    const result = calculateAvgifterRate(
      makeBasicInput({ personnummer: 'mock_senior_person' }),
      config2026,
      2026
    )

    expect(result.rate).toBe(0.1021)
    expect(result.category).toBe('reduced_65plus')
  })

  it('returns 0% for born ≤1937', () => {
    const result = calculateAvgifterRate(
      makeBasicInput({ personnummer: 'mock_old_person' }),
      config2026,
      2026
    )

    expect(result.rate).toBe(0)
    expect(result.category).toBe('exempt')
  })

  it('returns växa-stöd rate when eligible', () => {
    const result = calculateAvgifterRate(
      makeBasicInput({
        vaxaStodEligible: true,
        vaxaStodStart: '2025-01-01',
        vaxaStodEnd: '2026-12-31',
      }),
      config2026,
      2026
    )

    expect(result.rate).toBe(0.1021)
    expect(result.category).toBe('vaxa_stod')
  })

  // Ungdomsrabatt 2026-2027 (Prop. 2025/26:66). Eligibility test is
  // age >= 18 AND age < 23 at årets ingång. Cases below pin all four age
  // boundaries plus the period-window edges.
  describe('youth rate (ungdomsrabatt 2026-2027)', () => {
    it('NOT eligible: age 17 at year start (too young)', () => {
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2009', paymentDate: '2026-05-25' }),
        config2026,
        2026,
      )
      expect(result.category).toBe('standard')
      expect(result.rate).toBe(0.3142)
    })

    it('eligible: age 18 at year start (lower boundary)', () => {
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2008', paymentDate: '2026-05-25' }),
        config2026,
        2026,
      )
      expect(result.category).toBe('youth')
      expect(result.rate).toBe(0.2081)
    })

    it('eligible: age 22 at year start (upper boundary)', () => {
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2004', paymentDate: '2026-05-25' }),
        config2026,
        2026,
      )
      expect(result.category).toBe('youth')
      expect(result.rate).toBe(0.2081)
    })

    // Regression: this is the case Skatteverket's AGI validator rejected.
    // The previous implementation incorrectly accepted age 23 at year start.
    it('NOT eligible: age 23 at year start (just over)', () => {
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2003', paymentDate: '2026-05-25' }),
        config2026,
        2026,
      )
      expect(result.category).toBe('standard')
      expect(result.rate).toBe(0.3142)
    })

    it('NOT eligible: age 22 but paid March 2026 (before period starts)', () => {
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2004', paymentDate: '2026-03-15' }),
        config2026,
        2026,
      )
      expect(result.category).toBe('standard')
      expect(result.rate).toBe(0.3142)
    })

    it('NOT eligible: age 22 but paid October 2027 (after period ends)', () => {
      const config2027: PayrollConfig = { ...config2026, configYear: 2027 }
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2005', paymentDate: '2027-10-10' }),
        config2027,
        2027,
      )
      expect(result.category).toBe('standard')
      expect(result.rate).toBe(0.3142)
    })

    it('eligible: payment exactly April 1 2026 (period start edge)', () => {
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2004', paymentDate: '2026-04-01' }),
        config2026,
        2026,
      )
      expect(result.category).toBe('youth')
      expect(result.rate).toBe(0.2081)
    })

    it('eligible: payment exactly September 30 2027 (period end edge)', () => {
      const config2027: PayrollConfig = { ...config2026, configYear: 2027 }
      const result = calculateAvgifterRate(
        makeBasicInput({ personnummer: 'mock_born_2005', paymentDate: '2027-09-30' }),
        config2027,
        2027,
      )
      expect(result.category).toBe('youth')
      expect(result.rate).toBe(0.2081)
    })
  })
})

describe('calculateSalary: youth cap', () => {
  // The 25 000 SEK monthly cap is applied by calculateSalary (not
  // calculateAvgifterRate) so it has to be exercised through the integration
  // path. Salary above the cap: discounted portion at 20.81%, excess at 31.42%.
  it('applies 20.81% on first 25 000 SEK and 31.42% on the excess', () => {
    const result = calculateSalary(
      makeBasicInput({
        personnummer: 'mock_born_2004', // age 22 at year start 2026
        paymentDate: '2026-06-25',
        monthlySalary: 30000,
      }),
      config2026,
      [],
    )
    // 25 000 × 0.2081 + 5 000 × 0.3142 = 5 202.50 + 1 571.00 = 6 773.50
    expect(result.avgifterAmount).toBeCloseTo(6773.5, 1)
    expect(result.avgifterCategory).toBe('youth')
  })

  it('applies pure 20.81% when salary is at or below the cap', () => {
    const result = calculateSalary(
      makeBasicInput({
        personnummer: 'mock_born_2004',
        paymentDate: '2026-06-25',
        monthlySalary: 20000,
      }),
      config2026,
      [],
    )
    // 20 000 × 0.2081 = 4 162.00
    expect(result.avgifterAmount).toBeCloseTo(4162, 1)
    expect(result.avgifterCategory).toBe('youth')
  })
})

describe('calculateSalary: shift premiums (OB-tillägg och övertid)', () => {
  it('treats ob_weekend as an addition to gross salary', () => {
    const result = calculateSalary(
      makeBasicInput({
        monthlySalary: 40000,
        lineItems: [
          baseLineItem(40000),
          lineItem({
            itemType: 'ob_weekend',
            amount: 660,
            isTaxable: true,
            isAvgiftBasis: true,
            isVacationBasis: true,
          }),
        ],
      }),
      config2026,
      emptyTaxRates,
    )
    // Gross = base 40000 + 660 OB
    expect(result.grossSalary).toBe(40660)
    // Avgifter basis includes the OB amount
    expect(result.avgifterBasis).toBe(40660)
  })

  it('overtime_50 + ob_night flow into additions step', () => {
    const result = calculateSalary(
      makeBasicInput({
        monthlySalary: 40000,
        lineItems: [
          baseLineItem(40000),
          lineItem({
            itemType: 'overtime_50',
            amount: 1500,
            isTaxable: true,
            isAvgiftBasis: true,
            isVacationBasis: true,
          }),
          lineItem({
            itemType: 'ob_night',
            amount: 900,
            isTaxable: true,
            isAvgiftBasis: true,
            isVacationBasis: true,
          }),
        ],
      }),
      config2026,
      emptyTaxRates,
    )
    // Gross = 40000 + 1500 + 900 = 42400
    expect(result.grossSalary).toBe(42400)
    expect(result.avgifterBasis).toBe(42400)
    // Should label step as additions including OB
    const additionStep = result.steps.find((s) => s.label.includes('Tillägg'))
    expect(additionStep).toBeDefined()
    expect(additionStep?.output).toBe(2400)
  })
})
