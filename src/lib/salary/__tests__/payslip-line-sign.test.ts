/**
 * A deduction row is negative, and a positive row on a nettolöneavdrag repays
 * the employee, in the pay calculation and in the voucher alike. A sign no
 * row can mean is refused at the door, as the voucher refused it later.
 */
import { describe, expect, it } from 'vitest'
import { validateBalance } from '@/lib/bookkeeping/engine'
import { calculateSalary, type CalculationLineItem, type SalaryCalculationInput } from '../calculation-engine'
import type { PayrollConfig } from '../payroll-config'
import { buildSalaryRunEntryLines, salaryRunDataFromRows, type SalaryRosterRow } from '../salary-entries'
import { createPayslipLine, updatePayslipLine } from '../payslip-lines'
import { createPayrollFakeDb } from './payroll-fake-db'
import { draftRun, employee, line, rosterRow } from './payroll-fixtures'

const config = {
  configYear: 2026, avgifterTotal: 0.3142, avgifterAlderspension: 0.1021, avgifterSjukforsakring: 0.0355,
  avgifterForaldraforsakring: 0.02, avgifterEfterlevandepension: 0.003, avgifterArbetsmarknad: 0.0264,
  avgifterArbetsskada: 0.001, avgifterAllmanLoneavgift: 0.1262, avgifterReduced65plus: 0.1021,
  avgifterYouthRate: 0.2081, avgifterYouthSalaryCap: 25000, avgifterVaxaStodRate: 0.1021, avgifterVaxaStodCap: 35000,
  avgifterMinimumAnnual: 1000, egenavgifterTotal: 0.2897, slpRate: 0.2426, prisbasbelopp: 59200, inkomstbasbelopp: 83400,
  maxPgi: 625500, sgiCeiling: 592000, statligSkattBrytpunkt: 660400, traktamenteHeldag: 300, traktamenteHalvdag: 150,
  traktamenteNatt: 150, milersattningEgenBil: 25, milersattningFormansbilFossil: 12, milersattningFormansbilEl: 9.5,
  kostformanHeldag: 310, kostformanLunch: 124, kostformanFrukost: 62, friskvardCap: 5000, bilformanSlr: 0.0255,
  sjuklonRate: 0.8, karensavdragFactor: 0.2, maxKarensavdragPerYear: 10, reducedAvgiftAge: 67,
} satisfies PayrollConfig

const input = (lineItems: CalculationLineItem[]): SalaryCalculationInput => ({
  employmentType: 'employee', salaryType: 'monthly', monthlySalary: 40000, employmentDegree: 100,
  taxTableNumber: null, taxColumn: 1, isSidoinkomst: false, jamkningPercentage: null, jamkningValidFrom: null,
  jamkningValidTo: null, fSkattStatus: 'a_skatt', personnummer: 'mock', paymentDate: '2026-09-25',
  vacationRule: 'procentregeln', vacationDaysPerYear: 25, semestertillaggRate: 0.0043, vaxaStodEligible: false,
  vaxaStodStart: null, vaxaStodEnd: null, lineItems,
})

const net = (itemType: string, amount: number): CalculationLineItem => ({
  itemType: itemType as CalculationLineItem['itemType'], amount, isTaxable: false, isAvgiftBasis: false,
  isVacationBasis: false, isGrossDeduction: false, isNetDeduction: true,
})
const gross = (amount: number): CalculationLineItem => ({
  itemType: 'gross_deduction_other', amount, isTaxable: true, isAvgiftBasis: true,
  isVacationBasis: false, isGrossDeduction: true, isNetDeduction: false,
})
const reimbursement = (itemType: string, amount: number): CalculationLineItem => ({
  itemType: itemType as CalculationLineItem['itemType'], amount, isTaxable: false, isAvgiftBasis: false,
  isVacationBasis: false, isGrossDeduction: false, isNetDeduction: false,
})

function voucher(lines: CalculationLineItem[]) {
  const result = calculateSalary(input(lines), config, [])
  const row: SalaryRosterRow = {
    employee_id: 'e1', gross_salary: result.grossSalary, tax_withheld: result.taxWithheld, net_salary: result.netSalary,
    avgifter_amount: result.avgifterAmount, avgifter_basis: result.avgifterBasis, avgifter_rate: result.avgifterRate,
    avgifter_category: result.avgifterCategory, vacation_accrual: result.vacationAccrual, vacation_accrual_avgifter: result.vacationAccrualAvgifter,
    employee: { employment_type: 'employee', personnel_category: 'tjansteman', default_dimensions: null, f_skatt_status: 'a_skatt' },
    line_items: [
      { item_type: 'monthly_salary', amount: 40000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
      ...lines.map((l) => ({ item_type: l.itemType, amount: l.amount, account_number: null, is_net_deduction: l.isNetDeduction, is_gross_deduction: l.isGrossDeduction })),
    ],
  }
  const runRow = { id: 'r1', period_year: 2026, period_month: 9, payment_date: '2026-09-25', voucher_series: 'A', total_gross: 0, total_tax: 0, total_net: 0, total_avgifter: 0, total_vacation_accrual: 0, calculation_params: { avgifterTotal: 0.3142, avgifterYouthSalaryCap: 25000, slpRate: 0.2426 } }
  const built = buildSalaryRunEntryLines(salaryRunDataFromRows(runRow, [row]), 'Lön', '1930')
  return { result, balance: validateBalance(built.salaryLines), lines: built.salaryLines }
}

const onAccount = (lines: ReturnType<typeof voucher>['lines'], account: string) => lines.find((l) => l.account_number === account)

describe('a nettolöneavdrag', () => {
  it('withheld: the pay drops and the account is credited', () => {
    const { result, balance, lines } = voucher([net('net_deduction_other', -500)])
    expect(result).toMatchObject({ grossSalary: 40000, taxWithheld: 12000, netDeductions: 500, netSalary: 27500 })
    expect(balance.valid).toBe(true)
    expect(onAccount(lines, '2799')).toMatchObject({ debit_amount: 0, credit_amount: 500 })
  })

  it('repaid: the pay rises and the account is debited, so the voucher balances', () => {
    const { result, balance, lines } = voucher([net('net_deduction_other', 500)])
    expect(result).toMatchObject({ grossSalary: 40000, taxWithheld: 12000, netDeductions: -500, netSalary: 28500 })
    expect(balance.valid).toBe(true)
    expect(onAccount(lines, '2799')).toMatchObject({ debit_amount: 500, credit_amount: 0 })
    expect(onAccount(lines, '1930')).toMatchObject({ credit_amount: 28500 })
  })

  it('a withheld and a repaid row net off', () => {
    const { result, balance } = voucher([net('net_deduction_other', -500), net('net_deduction_advance', 200)])
    expect(result).toMatchObject({ netDeductions: 300, netSalary: 27700 })
    expect(balance.valid).toBe(true)
  })
})

describe('a bruttolöneavdrag', () => {
  it('lowers the pay with its sign', () => {
    const { result, balance } = voucher([gross(-1000)])
    expect(result).toMatchObject({ grossDeductions: 1000, grossSalary: 39000 })
    expect(balance.valid).toBe(true)
  })

  it('a positive row, which the doors now refuse, is never read as a deduction', () => {
    const { result, balance } = voucher([gross(1000)])
    expect(result).toMatchObject({ grossDeductions: -1000, grossSalary: 41000 })
    expect(balance.valid).toBe(true)
  })
})

describe('a kostnadsersättning', () => {
  it('rides on the payout', () => {
    const { result, balance } = voucher([reimbursement('mileage_taxfree', 300)])
    expect(result).toMatchObject({ taxFreeReimbursements: 300, netSalary: 28300 })
    expect(balance.valid).toBe(true)
  })

  it.each(['mileage_taxfree', 'traktamente_taxfree'])('%s negative, which the doors now refuse, still balances the voucher', (itemType) => {
    const { result, balance } = voucher([reimbursement(itemType, -300)])
    expect(result).toMatchObject({ taxFreeReimbursements: -300, netSalary: 27700 })
    expect(balance.valid).toBe(true)
  })
})

describe('the line commands', () => {
  const C = 'company-1'
  function db() {
    const emp = employee(C, 'anna', { personnummer: 'x' })
    const sre = rosterRow(C, 'run-1', emp)
    return createPayrollFakeDb({
      salary_runs: [draftRun(C, 'run-1', { period_year: 2026, period_month: 9, payment_date: '2026-09-25' })],
      employees: [emp],
      salary_run_employees: [sre],
      salary_line_items: [line(C, sre.id as string, 'mileage', { item_type: 'mileage_taxfree', description: 'x', amount: 300, is_taxable: false, is_avgift_basis: false, is_vacation_basis: false })],
    })
  }
  const create = (fake: ReturnType<typeof db>, itemType: string, amount: number) =>
    createPayslipLine(fake.supabase, {
      companyId: C,
      salaryRunId: 'run-1',
      target: { employeeId: 'anna' },
      input: { item_type: itemType, description: 'x', amount, sort_order: 0 } as never,
    })

  it.each([
    ['mileage_taxfree', -300],
    ['traktamente_taxfree', -300],
    ['expense_reimbursement', -300],
    ['benefit_meals', -100],
    ['benefit_other', -100],
    ['gross_deduction_other', 1000],
    ['gross_deduction_pension', 1000],
  ])('refuse %s at %d, a sign that row cannot mean', async (itemType, amount) => {
    const result = await create(db(), itemType, amount)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'amount' } })
  })

  it.each([
    ['net_deduction_other', 500],
    ['net_deduction_other', -500],
    ['gross_deduction_other', -500],
    ['mileage_taxfree', 300],
    ['benefit_other', 100],
    ['correction', -500],
    ['other', -500],
    ['bonus', 500],
  ])('accept %s at %d', async (itemType, amount) => {
    expect(await create(db(), itemType, amount)).toMatchObject({ ok: true })
  })

  it('refuse a patch that turns the sign, and leave an unrelated edit of an old row alone', async () => {
    const fake = db()
    expect(await updatePayslipLine(fake.supabase, { companyId: C, salaryRunId: 'run-1', lineId: 'mileage', patch: { amount: -300 } })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'amount' },
    })
    fake.edit('salary_line_items', 'mileage', { amount: -300 })
    expect(await updatePayslipLine(fake.supabase, { companyId: C, salaryRunId: 'run-1', lineId: 'mileage', patch: { description: 'Ny text' } })).toMatchObject({ ok: true })
  })
})
