import { describe, it, expect, vi } from 'vitest'
import { calculateSalary } from '../calculation-engine'
import {
  benefitPaymentRefusalDetails,
  collectDescribedLines,
  describeDoubleBenefitAdjustments,
  doubleBenefitAdjustmentWarning,
  findDoubleBenefitAdjustments,
  resolveTaxableBenefits,
  staleBenefitTotalRefusal,
} from '../benefit-payments'
import { roundOre } from '@/lib/money'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { PayrollConfig } from '../payroll-config'
import type { TaxTableRate } from '../tax-tables'

// An employee's payment for a benefit, taken as a nettolöneavdrag, reduces the
// taxable förmånsvärde (swedish-payroll skill, deductions-lonevaxling.md:
// "DOES reduce the taxable förmånsvärde if the deduction constitutes payment
// for a specific benefit"; benefits.md: "If the employee pays >= schablonvärde
// via nettolöneavdrag, no taxable benefit arises").

vi.mock('../personnummer', () => ({
  decryptPersonnummer: () => '199001011234',
  calculateAgeAtYearStart: (pnr: string, year: number) => year - 1 - parseInt(pnr.slice(0, 4)),
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

// The shape measured on prod 2026-09-21 (amounts only): salary 48 000, a car
// benefit of 6 664 and a payment of the same amount. Three brackets so the
// tax proves WHICH base was looked up:
//   41 336 = the base when a same-amount bruttolöneavdrag adjusts a second time
//   48 000 = correct: the salary, no taxable benefit left
//   54 664 = the pre-fix base: salary plus the whole benefit
const taxRates: TaxTableRate[] = [
  { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 0, incomeTo: 45000, kind: 'amount', taxAmount: 8000 },
  { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 45001, incomeTo: 50000, kind: 'amount', taxAmount: 10050 },
  { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 50001, incomeTo: 90000, kind: 'amount', taxAmount: 12500 },
]

const SALARY = 48000
const CAR = 6664

type Line = { itemType: string; amount: number; isNetDeduction?: boolean; isGrossDeduction?: boolean }

function input(lineItems: Line[]) {
  return {
    employmentType: 'company_owner' as const,
    salaryType: 'monthly' as const,
    monthlySalary: SALARY,
    employmentDegree: 100,
    taxTableNumber: 32,
    taxColumn: 1,
    isSidoinkomst: false,
    jamkningPercentage: null,
    jamkningValidFrom: null,
    jamkningValidTo: null,
    fSkattStatus: 'a_skatt',
    personnummer: 'mock',
    paymentDate: '2026-09-25',
    vacationRule: 'none' as const,
    vacationDaysPerYear: 25,
    semestertillaggRate: 0.0043,
    vaxaStodEligible: false,
    vaxaStodStart: null,
    vaxaStodEnd: null,
    lineItems: lineItems.map((li) => ({
      itemType: li.itemType as never,
      amount: li.amount,
      isTaxable: !li.isNetDeduction,
      isAvgiftBasis: !li.isNetDeduction,
      isVacationBasis: false,
      isGrossDeduction: li.isGrossDeduction ?? false,
      isNetDeduction: li.isNetDeduction ?? false,
    })),
  }
}

const car = (amount = CAR): Line => ({ itemType: 'benefit_car', amount })
const meals = (amount: number): Line => ({ itemType: 'benefit_meals', amount })
const payment = (amount: number): Line => ({ itemType: 'net_deduction_benefit_payment', amount, isNetDeduction: true })
const grossDeduction = (amount: number, itemType = 'gross_deduction_other'): Line => ({
  itemType,
  amount,
  isGrossDeduction: true,
})

describe('calculateSalary: an employee payment for a benefit reduces the taxable benefit value', () => {
  it('baseline: a car benefit with no payment is taxed in full (unchanged behaviour)', () => {
    const r = calculateSalary(input([car()]), config2026, taxRates)
    expect(r.benefitValues).toBe(CAR)
    expect(r.taxableIncome).toBe(54664)
    expect(r.avgifterBasis).toBe(54664)
    expect(r.taxWithheld).toBe(12500)
  })

  it('payment equal to the benefit: no taxable benefit arises', () => {
    const r = calculateSalary(input([car(), payment(-CAR)]), config2026, taxRates)
    expect(r.grossSalary).toBe(SALARY)
    expect(r.benefitValues).toBe(0)
    expect(r.taxableIncome).toBe(SALARY)
    // Looked up on 48 000, not on 54 664.
    expect(r.taxWithheld).toBe(10050)
    expect(r.avgifterBasis).toBe(SALARY)
    expect(r.avgifterAmount).toBe(roundOre(SALARY * 0.3142))
    expect(r.netDeductions).toBe(CAR)
    // 48 000 - 10 050 - 6 664
    expect(r.netSalary).toBe(31286)
  })

  it('partial payment: taxable benefit = benefit - payment', () => {
    const r = calculateSalary(input([car(), payment(-2000)]), config2026, taxRates)
    expect(r.benefitValues).toBe(4664)
    expect(r.taxableIncome).toBe(52664)
    expect(r.avgifterBasis).toBe(52664)
    expect(r.taxWithheld).toBe(12500)
    expect(r.netDeductions).toBe(2000)
    expect(r.netSalary).toBe(SALARY - 12500 - 2000)
  })

  it('over-payment: taxable benefit floors at 0, the whole payment still leaves net pay', () => {
    const r = calculateSalary(input([car(), payment(-8000)]), config2026, taxRates)
    expect(r.benefitValues).toBe(0)
    expect(r.taxableIncome).toBe(SALARY)
    expect(r.avgifterBasis).toBe(SALARY)
    expect(r.taxWithheld).toBe(10050)
    expect(r.netDeductions).toBe(8000)
    expect(r.netSalary).toBe(SALARY - 10050 - 8000)
  })

  it('a payment with no benefit on the payslip stays a plain net deduction', () => {
    const r = calculateSalary(input([payment(-4968)]), config2026, taxRates)
    expect(r.benefitValues).toBe(0)
    expect(r.taxableIncome).toBe(SALARY)
    expect(r.netSalary).toBe(SALARY - 10050 - 4968)
  })

  it('explains the reduction on the payslip breakdown, and only when there is one', () => {
    const label = 'Förmånsvärde efter den anställdes betalning'
    const reduced = calculateSalary(input([car(), payment(-CAR)]), config2026, taxRates)
    const step = reduced.steps.find((s) => s.label === label)
    expect(step?.output).toBe(0)
    expect(step?.input).toMatchObject({ benefit_values: CAR, employee_payment: CAR, reduction: CAR })
    const plain = calculateSalary(input([car()]), config2026, taxRates)
    expect(plain.steps.some((s) => s.label === label)).toBe(false)
  })

  it('is idempotent: the same line set gives the same result (nothing is persisted between runs)', () => {
    const lines = [car(), payment(-CAR)]
    const first = calculateSalary(input(lines), config2026, taxRates)
    const second = calculateSalary(input(lines), config2026, taxRates)
    expect(second).toEqual(first)
  })

  it('refuses a payment on a payslip with several benefit types instead of guessing', () => {
    expect(() => calculateSalary(input([car(), meals(2480), payment(-2480)]), config2026, taxRates)).toThrow(
      /flera förmånstyper \(bilförmån, kostförmån\)/,
    )
  })

  it('the pre-fix workaround (same-amount bruttolöneavdrag) now under-taxes: the reason it must be warned about', () => {
    const r = calculateSalary(input([car(), payment(-CAR), grossDeduction(-CAR)]), config2026, taxRates)
    expect(r.taxableIncome).toBe(41336)
    expect(r.taxWithheld).toBe(8000)
  })
})

describe('resolveTaxableBenefits', () => {
  const resolved = (lines: Line[]) => {
    const result = resolveTaxableBenefits(lines)
    if (!result.ok) throw new Error(result.error)
    return result.benefits
  }

  it('reduces the one benefit type per type, so the AGI field carries the reduced value', () => {
    const b = resolved([car(), payment(-2000)])
    expect(b.grossByType).toEqual({ benefit_car: CAR })
    expect(b.taxableByType).toEqual({ benefit_car: 4664 })
    expect(b).toMatchObject({ grossTotal: CAR, paid: 2000, reduction: 2000, taxableTotal: 4664 })
  })

  it('sums several lines of the same type and several payments', () => {
    const b = resolved([car(4000), car(2664), payment(-3000), payment(-664)])
    expect(b.taxableByType).toEqual({ benefit_car: 3000 })
    expect(b).toMatchObject({ paid: 3664, reduction: 3664, taxableTotal: 3000 })
  })

  it('caps the reduction at the benefit: never a negative förmånsvärde', () => {
    const b = resolved([car(), payment(-8000)])
    expect(b.taxableByType).toEqual({ benefit_car: 0 })
    expect(b).toMatchObject({ paid: 8000, reduction: CAR, taxableTotal: 0 })
  })

  it('several benefit types without a payment are untouched', () => {
    const b = resolved([car(), meals(2480)])
    expect(b.taxableByType).toEqual({ benefit_car: CAR, benefit_meals: 2480 })
    expect(b).toMatchObject({ reduction: 0, taxableTotal: 9144 })
  })

  it('a positive payment row is a repayment to the employee and lowers nothing', () => {
    const b = resolved([car(), payment(500)])
    expect(b).toMatchObject({ paid: 0, reduction: 0, taxableTotal: CAR })
  })

  it('without a payment the total is the historical engine total, to the bit, for awkward öre sums', () => {
    // The engine used to sum benefit rows and round once. Expected values are
    // built from integer öre, so this does not lean on either rounding helper.
    const cases = [[670.17, 670.17, 670.17], [0.1, 0.2], [1005.55, 0.45], [19.99, 0.01, 4664.5], [3332.33, 3331.67]]
    for (const amounts of cases) {
      const ore = amounts.reduce((sum, a) => sum + Math.round(a * 100), 0)
      const b = resolved(amounts.map((a) => car(a)))
      expect(b.grossTotal).toBe(ore / 100)
      expect(b.taxableTotal).toBe(ore / 100)
    }
  })

  it('keeps öre exact', () => {
    const b = resolved([car(670.17), payment(-670.17)])
    expect(b).toMatchObject({ reduction: 670.17, taxableTotal: 0 })
  })

  it('refuses several benefit types with a payment, naming them', () => {
    const result = resolveTaxableBenefits([car(), meals(2480), payment(-100)])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('bilförmån, kostförmån')
  })
})

describe('findDoubleBenefitAdjustments', () => {
  const find = (lines: Line[]) => {
    const result = resolveTaxableBenefits(lines)
    if (!result.ok) throw new Error(result.error)
    return findDoubleBenefitAdjustments(lines, result.benefits)
  }

  it('flags the exact prod shape: salary, car benefit, payment and a same-amount bruttolöneavdrag', () => {
    const workaround = grossDeduction(-CAR)
    expect(find([car(), payment(-CAR), workaround])).toEqual([workaround])
  })

  it('no warning without such a line', () => {
    expect(find([car(), payment(-CAR)])).toEqual([])
  })

  it('no warning for a bruttolöneavdrag of another amount', () => {
    expect(find([car(), payment(-CAR), grossDeduction(-5000)])).toEqual([])
  })

  it('an öre apart is not a match', () => {
    expect(find([car(), payment(-CAR), grossDeduction(-6664.01)])).toEqual([])
  })

  it('no warning when the payment reduces nothing (no benefit on the payslip)', () => {
    expect(find([payment(-CAR), grossDeduction(-CAR)])).toEqual([])
  })

  it('matches each payment row, not only the total', () => {
    const a = grossDeduction(-3000)
    const b = grossDeduction(-3664)
    expect(find([car(), payment(-3000), payment(-3664), a, b])).toEqual([a, b])
  })

  it('a pension bruttolöneavdrag of the same amount is flagged too: the text asks, it does not assert', () => {
    const pension = grossDeduction(-CAR, 'gross_deduction_pension')
    expect(find([car(), payment(-CAR), pension])).toEqual([pension])
  })

  it('derived absence rows carry is_gross_deduction but are never flagged', () => {
    expect(find([car(), payment(-CAR), grossDeduction(-CAR, 'vab')])).toEqual([])
  })
})

describe('the run-level warning, from rows as run-calculation sees them', () => {
  // The prod shape: the salary is hand-entered, the car comes from the benefit
  // register, and BOTH deductions come from employee_recurring_lines, so the
  // pair returns in every new run until the customer removes the recurring row.
  const stored = [
    { item_type: 'monthly_salary', amount: 48000, description: 'Grundlön' },
    // Stale derived rows from the previous calculation: replaced, never read.
    { item_type: 'benefit_car', amount: 6664, description: 'Bilförmån', source_benefit_id: 'b-1' },
    { item_type: 'gross_deduction_other', amount: -6664, description: 'gammal', source_recurring_line_id: 'r-0' },
  ]
  const recurring = [
    { item_type: 'net_deduction_benefit_payment', amount: -6664, description: 'Nettolöneavdrag bil' },
    { item_type: 'gross_deduction_other', amount: -6664, description: 'Bilförmån justering vid nettolöneavdrag' },
  ]
  const benefitsOf = (lines: Array<{ itemType: string; amount: number }>) => {
    const result = resolveTaxableBenefits(lines)
    if (!result.ok) throw new Error(result.error)
    return result.benefits
  }
  const CAR_LINE = { itemType: 'benefit_car', amount: 6664, description: 'Bilförmån', fromRecurringLine: false }

  it('names the employee and the row, and says it is removed under Återkommande lönerader', () => {
    const lines = [...collectDescribedLines(stored, recurring), CAR_LINE]
    const entries = describeDoubleBenefitAdjustments('Anna Andersson', lines, benefitsOf(lines))
    expect(entries).toEqual([
      'Anna Andersson: bruttolöneavdraget "Bilförmån justering vid nettolöneavdrag" (6\u00a0664 kr) ' +
        'tas bort under Återkommande lönerader på den anställde',
    ])
    const warning = doubleBenefitAdjustmentWarning(entries)
    expect(warning).toContain('sätts nu ned automatiskt')
    expect(warning).toContain('för låga')
    expect(warning).toContain('om den inte är ett verkligt bruttolöneavdrag')
  })

  it('skips stored rows that carry a register back-link: the fresh derivation replaces them', () => {
    const lines = collectDescribedLines(stored, recurring)
    expect(lines.map((li) => li.description)).toEqual([
      'Grundlön',
      'Nettolöneavdrag bil',
      'Bilförmån justering vid nettolöneavdrag',
    ])
  })

  it('a hand-entered workaround row is removed on the payslip instead', () => {
    const lines = [
      ...collectDescribedLines(
        [...stored, { item_type: 'gross_deduction_other', amount: -6664, description: 'Justering' }],
        [recurring[0]],
      ),
      CAR_LINE,
    ]
    const entries = describeDoubleBenefitAdjustments('Anna Andersson', lines, benefitsOf(lines))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toContain('"Justering"')
    expect(entries[0]).toContain('tas bort på lönebeskedet')
  })

  it('no suspect row, no warning', () => {
    const lines = [...collectDescribedLines(stored, [recurring[0]]), CAR_LINE]
    const entries = describeDoubleBenefitAdjustments('Anna Andersson', lines, benefitsOf(lines))
    expect(entries).toEqual([])
    expect(doubleBenefitAdjustmentWarning(entries)).toBeNull()
  })
})

describe('the refusal reaches the user as written', () => {
  // The client renders VALIDATION_ERROR issues only as { message } objects and
  // cuts them at 500 characters. A bare string falls back to the generic
  // "Förfrågan innehåller ogiltiga uppgifter.", which tells the user nothing.
  const allSixTypes = [
    { itemType: 'benefit_car', amount: 1 },
    { itemType: 'benefit_housing', amount: 1 },
    { itemType: 'benefit_meals', amount: 1 },
    { itemType: 'benefit_wellness', amount: 1 },
    { itemType: 'benefit_bike', amount: 1 },
    { itemType: 'benefit_other', amount: 1 },
    { itemType: 'net_deduction_benefit_payment', amount: -1 },
  ]

  it('renders in full through getErrorMessage, even with every benefit type and a long name', () => {
    const result = resolveTaxableBenefits(allSixTypes)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const name = 'Anna-Karin Margareta von Andersson-Lindqvist'
    const details = benefitPaymentRefusalDetails(name, result.error)
    const shown = getErrorMessage(
      { error: { code: 'VALIDATION_ERROR', message: 'x', details } },
      { context: 'salary', statusCode: 400 },
    )
    expect(shown).toBe(`${name}: ${result.error}`)
    expect(shown.length).toBeLessThanOrEqual(500)
    expect(shown).toContain('ta bort avdraget')
  })
})

describe('staleBenefitTotalRefusal: one rule for the AGI and the KU', () => {
  const benefitsOf = (lines: Array<{ itemType: string; amount: number }>) => {
    const result = resolveTaxableBenefits(lines)
    if (!result.ok) throw new Error(result.error)
    return result.benefits
  }
  const paidInFull = benefitsOf([car(), payment(-CAR)])
  const base = { who: 'Anställd 7', periodYear: 2026, periodMonth: 9 }

  it('refuses when the stored förmånsvärde is the unreduced one, naming employee, period and document', () => {
    const refusal = staleBenefitTotalRefusal({
      ...base, document: 'kontrolluppgiften', storedBenefitValues: CAR, benefits: paidInFull,
    })
    expect(refusal).toContain('Anställd 7, 2026-09')
    expect(refusal).toContain('Räkna om lönekörningen (Tillbaka till utkast)')
    expect(refusal).toContain('korrigera den (Korrigera lönekörning)')
    expect(refusal).toContain('innan kontrolluppgiften skapas')
  })

  it('names the other document for the AGI', () => {
    expect(
      staleBenefitTotalRefusal({ ...base, document: 'arbetsgivardeklarationen', storedBenefitValues: CAR, benefits: paidInFull }),
    ).toContain('innan arbetsgivardeklarationen skapas')
  })

  it('passes a payslip the fixed engine calculated', () => {
    expect(
      staleBenefitTotalRefusal({ ...base, document: 'kontrolluppgiften', storedBenefitValues: 0, benefits: paidInFull }),
    ).toBeNull()
    expect(
      staleBenefitTotalRefusal({
        ...base, document: 'kontrolluppgiften', storedBenefitValues: 4664, benefits: benefitsOf([car(), payment(-2000)]),
      }),
    ).toBeNull()
  })

  it('never touches a payslip without a reduction, so no historical run can trip it', () => {
    expect(
      staleBenefitTotalRefusal({ ...base, document: 'kontrolluppgiften', storedBenefitValues: 1, benefits: benefitsOf([car()]) }),
    ).toBeNull()
  })

  it('compares in whole öre, so float noise is not a mismatch', () => {
    expect(
      staleBenefitTotalRefusal({
        ...base, document: 'kontrolluppgiften', storedBenefitValues: 0.1 + 0.2,
        benefits: benefitsOf([car(670.47), payment(-670.17)]),
      }),
    ).toBeNull()
  })
})
