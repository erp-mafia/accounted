import { describe, it, expect, vi } from 'vitest'
import { calculateSalary } from '../calculation-engine'
import { loadPayrollConfig, serializePayrollConfig, type PayrollConfig } from '../payroll-config'
import { resolveTaxableBenefits } from '../benefit-payments'
import {
  buildManualPayslipLine,
  mealBenefitSchablonFromRunParams,
  type ManualLineBody,
} from '../manual-payslip-lines'
import { PAYROLL_CONFIG_2026 } from './payroll-fixtures'
import { roundOre } from '@/lib/money'
import type { TaxTableRate } from '../tax-tables'

// A one-off förmån entered on the payslip ("Lägg till rad", crm#1349) is the
// same benefit row the employee's standing benefit derives (run-calculation.ts
// step 8d): the engine, the AGI (FK012 via resolveTaxableBenefits) and the
// booking read benefits by item type, never by where the row came from. The
// kostförmån price is Skatteverket's schablon for the year (swedish-payroll
// references/benefits.md, 2026: lunch eller middag 124 kr), read from the
// payroll config the calculation froze on the run.

vi.mock('../personnummer', () => ({
  decryptPersonnummer: () => '199001011234',
  calculateAgeAtYearStart: (pnr: string, year: number) => year - 1 - parseInt(pnr.slice(0, 4)),
}))

// The real mapper over the fixture row, so the test reads the config the way
// a run does: salary_payroll_config row -> PayrollConfig -> calculation_params.
async function config2026(): Promise<PayrollConfig> {
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: PAYROLL_CONFIG_2026, error: null }) }),
      }),
    }),
  }
  return loadPayrollConfig(supabase as never, 2026)
}

// Two brackets, so the tax proves the benefit entered the base.
const taxRates: TaxTableRate[] = [
  { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 0, incomeTo: 40000, kind: 'amount', taxAmount: 9000 },
  { tableYear: 2026, tableNumber: 32, columnNumber: 1, incomeFrom: 40001, incomeTo: 60000, kind: 'amount', taxAmount: 9500 },
]

const SALARY = 40000

type EngineLine = Parameters<typeof calculateSalary>[0]['lineItems'][number]

/** A stored payslip row as the engine reads it, whichever door wrote it. */
type StoredRow = Pick<ManualLineBody, 'amount' | 'is_taxable' | 'is_avgift_basis' | 'is_vacation_basis' | 'is_gross_deduction' | 'is_net_deduction'> & {
  item_type: string
}

function engineLine(row: StoredRow): EngineLine {
  return {
    itemType: row.item_type as never,
    amount: row.amount,
    isTaxable: row.is_taxable,
    isAvgiftBasis: row.is_avgift_basis,
    isVacationBasis: row.is_vacation_basis,
    isGrossDeduction: row.is_gross_deduction,
    isNetDeduction: row.is_net_deduction,
  }
}

/** The row run-calculation.ts step 8d derives from a standing employee_benefits row. */
function derivedBenefitRow(itemType: string, monthlyValue: number): StoredRow {
  return {
    item_type: itemType,
    amount: roundOre(monthlyValue),
    is_taxable: true,
    is_avgift_basis: true,
    is_vacation_basis: false,
    is_gross_deduction: false,
    is_net_deduction: false,
  }
}

function input(lineItems: EngineLine[]) {
  return {
    employmentType: 'employee' as const,
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
    paymentDate: '2026-10-25',
    vacationRule: 'none' as const,
    vacationDaysPerYear: 25,
    semestertillaggRate: 0.0043,
    vaxaStodEligible: false,
    vaxaStodStart: null,
    vaxaStodEnd: null,
    lineItems,
  }
}

function built(r: ReturnType<typeof buildManualPayslipLine>): ManualLineBody {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)
  return r.body
}

describe('a one-off kostförmån on the payslip (crm#1349)', () => {
  it('prices nine dinners at the year schablon the calculation froze on the run', async () => {
    const config = await config2026()
    const schablon = mealBenefitSchablonFromRunParams(serializePayrollConfig(config))
    expect(schablon).toEqual({ year: 2026, perKind: { lunch_middag: 124, frukost: 62, heldag: 310 } })

    const row = built(
      buildManualPayslipLine({
        item_type: 'benefit_meals',
        meal_kind: 'lunch_middag',
        quantity: 9,
        unit_price: schablon.perKind.lunch_middag,
      }),
    )
    expect(row).toMatchObject({
      item_type: 'benefit_meals',
      description: 'Kostförmån, lunch eller middag',
      quantity: 9,
      unit_price: 124,
      amount: 1116,
    })
  })

  it('is taxed, in the avgiftsunderlag and not paid out, exactly like the standing kostförmån', async () => {
    const config = await config2026()
    const oneOff = built(buildManualPayslipLine({ item_type: 'benefit_meals', meal_kind: 'lunch_middag', quantity: 9, unit_price: 124 }))
    const standing = derivedBenefitRow('benefit_meals', 1116)

    const fromLine = calculateSalary(input([engineLine(oneOff)]), config, taxRates)
    const fromEmployee = calculateSalary(input([engineLine(standing)]), config, taxRates)
    const none = calculateSalary(input([]), config, taxRates)

    // Avgifter on cash pay plus förmånsvärde (swedish-payroll SKILL.md:
    // "Calculated on full gross salary + taxable benefits").
    expect(fromLine.grossSalary).toBe(SALARY)
    expect(fromLine.benefitValues).toBe(1116)
    expect(fromLine.taxableIncome).toBe(41116)
    expect(fromLine.avgifterBasis).toBe(41116)
    expect(fromLine.taxWithheld).toBe(9500)
    // The benefit is never paid out: net is the cash pay less the tax.
    expect(fromLine.netSalary).toBe(SALARY - 9500)
    expect(fromLine.avgifterAmount).toBeGreaterThan(none.avgifterAmount)

    for (const key of ['grossSalary', 'benefitValues', 'taxableIncome', 'avgifterBasis', 'avgifterAmount', 'taxWithheld', 'netSalary'] as const) {
      expect(fromLine[key], key).toBe(fromEmployee[key])
    }
  })

  it('reaches the AGI benefit value by type, as the standing kostförmån does', () => {
    const oneOff = built(buildManualPayslipLine({ item_type: 'benefit_meals', meal_kind: 'frukost', quantity: 5, unit_price: 62 }))
    const resolved = resolveTaxableBenefits([{ itemType: oneOff.item_type, amount: oneOff.amount }])
    const standing = resolveTaxableBenefits([{ itemType: 'benefit_meals', amount: 310 }])
    expect(resolved.ok && standing.ok).toBe(true)
    if (!resolved.ok || !standing.ok) return
    expect(resolved.benefits.taxableByType).toEqual({ benefit_meals: 310 })
    expect(resolved.benefits.taxableByType).toEqual(standing.benefits.taxableByType)
  })
})

describe('a one-off övrig förmån on the payslip (crm#1349)', () => {
  it('is taxed and in the avgiftsunderlag like the standing övrig förmån', async () => {
    const config = await config2026()
    const oneOff = built(buildManualPayslipLine({ item_type: 'benefit_other', amount: 2500 }))
    const fromLine = calculateSalary(input([engineLine(oneOff)]), config, taxRates)
    const fromEmployee = calculateSalary(input([engineLine(derivedBenefitRow('benefit_other', 2500))]), config, taxRates)
    expect(fromLine.benefitValues).toBe(2500)
    expect(fromLine.avgifterBasis).toBe(42500)
    expect(fromLine.netSalary).toBe(SALARY - 9500)
    for (const key of ['benefitValues', 'taxableIncome', 'avgifterBasis', 'avgifterAmount', 'taxWithheld', 'netSalary'] as const) {
      expect(fromLine[key], key).toBe(fromEmployee[key])
    }
  })
})
