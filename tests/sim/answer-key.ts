/**
 * What the books of the simulated company must say, worked out from the
 * generator's facts and Swedish rules alone. Nothing here imports product code
 * beyond the öre rounding, and that is the point: a report is judged against
 * arithmetic it had no part in, so a wrong report cannot agree with itself.
 *
 * The key keeps its own small ledger in statement lines, not BAS accounts: the
 * generator knows a sale of 1 000 kr at 25 % owes 250 kr of moms, and it does
 * not need to know which account the product books that on. Every event posts
 * balanced amounts, positive for debit.
 *
 * Rules, each from the swedish-* skills:
 *   moms           rutor per ML; filed amounts drop the öre per ruta (SFL), the
 *                  gap goes to öresutjämning inside nettoomsättningen
 *   avgifter       31.42 % of gross, born 1959 or later, no cap; filed in whole
 *                  kronor on the month's total underlag, the öre to öresutjämning
 *   skatteavdrag   column 1 of the employee's table, by the gross of the month
 *   semester       procentregeln: 12 % of gross, plus avgifter on it
 *   avskrivning    linear from the day of purchase, whole kronor per year
 *   bolagsskatt    20.6 % of the result with non-deductible cost added back,
 *                  the base floored to a whole ten kronor
 *   representation meals give no income tax deduction; moms is deductible up to
 *                  300 kr per person, which these lunches stay under
 */
import { roundOre } from '@/lib/money'
import taxTables from './fixtures/tax-tables.json'
import type { SimEmployee, SimEvent, SimPlan, VatRate } from './generate'

const AVGIFTER_RATE = 0.3142
const VACATION_RATE = 0.12
const CORPORATE_TAX_RATE = 0.206
/** Moms the buyer accounts for itself on services from another EU country. */
const REVERSE_CHARGE_RATE = 25

type TaxRow = [from: number, to: number, column1: number]
const TAX_TABLES = taxTables as unknown as Record<string, Record<string, { amount: TaxRow[] }>>

export const LINES = [
  // Income statement
  'revenue',
  'externalCosts',
  'personnelCosts',
  'depreciation',
  'corporateTax',
  // Assets
  'tangibleAssets',
  'receivables',
  'cash',
  // Equity and liabilities
  'shareCapital',
  'supplierPayables',
  'corporateTaxLiability',
  'vatLiability',
  'payrollLiabilities',
  'accruedVacation',
] as const
export type Line = (typeof LINES)[number]

export interface VatBoxes {
  ruta05: number
  ruta10: number
  ruta11: number
  ruta12: number
  ruta21: number
  ruta30: number
  ruta39: number
  ruta40: number
  ruta48: number
  /** To pay, exact to the öre. */
  ruta49: number
  /** To pay as filed, whole kronor. */
  filedNet: number
}

export interface AgiEmployee {
  key: string
  gross: number
  tax: number
  avgifter: number
}

export interface PayrollMonth {
  year: number
  month: number
  employees: AgiEmployee[]
  totalGross: number
  totalTax: number
  /** The cost, exact to the öre per employee. */
  totalAvgifter: number
  /** The declared amount, whole kronor: what the skattekonto is charged. */
  filedAvgifter: number
  totalNet: number
  /** Skatteavdrag plus filed avgifter. */
  payable: number
}

export interface YearFigures {
  year: number
  /** Income statement, costs as positive amounts. */
  revenue: number
  externalCosts: number
  personnelCosts: number
  depreciation: number
  resultBeforeTax: number
  corporateTax: number
  result: number
  nonDeductibleCosts: number
  taxBase: number
  /** Balance sheet at the last day of the year. */
  tangibleAssets: number
  receivables: number
  cash: number
  totalAssets: number
  shareCapital: number
  retainedEarnings: number
  supplierPayables: number
  corporateTaxLiability: number
  vatLiability: number
  payrollLiabilities: number
  accruedVacation: number
  totalEquityAndLiabilities: number
}

export interface AnswerKey {
  /** Keyed '2024-Q1'. */
  vat: Record<string, VatBoxes>
  /** Keyed '2024-01', the payment month. */
  payroll: Record<string, PayrollMonth>
  /** The two closed years and the open one up to its last event. */
  years: Record<number, YearFigures>
  /** Bolagsskatt by income year. */
  corporateTax: Record<number, number>
}

const emptyBoxes = (): VatBoxes => ({
  ruta05: 0, ruta10: 0, ruta11: 0, ruta12: 0, ruta21: 0, ruta30: 0, ruta39: 0, ruta40: 0, ruta48: 0, ruta49: 0, filedNet: 0,
})

export const vatKey = (year: number, quarter: number) => `${year}-Q${quarter}`
export const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`
const quarterOf = (date: string) => Math.ceil(Number(date.slice(5, 7)) / 3)
const vatKeyOf = (date: string) => vatKey(Number(date.slice(0, 4)), quarterOf(date))

const OUTPUT_BOX: Record<Exclude<VatRate, 0>, 'ruta10' | 'ruta11' | 'ruta12'> = { 25: 'ruta10', 12: 'ruta11', 6: 'ruta12' }

export function monthlyTax(employee: SimEmployee, year: number, gross: number): number {
  const rows = TAX_TABLES[String(year)]?.[String(employee.taxTable)]?.amount
  const row = rows?.find(([from, to]) => gross >= from && gross <= to)
  if (!row) throw new Error(`no tax table row for ${gross} kr in ${year}, table ${employee.taxTable}`)
  return row[2]
}

export function payrollFor(plan: SimPlan, year: number, month: number): PayrollMonth {
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const active = plan.employees.filter((employee) => employee.start <= lastDay && employee.salary[year] !== undefined)
  const employees = active.map((employee) => {
    const gross = employee.salary[year]
    return { key: employee.key, gross, tax: monthlyTax(employee, year, gross), avgifter: roundOre(gross * AVGIFTER_RATE) }
  })
  const totalGross = sum(employees.map((row) => row.gross))
  const totalTax = sum(employees.map((row) => row.tax))
  const totalAvgifter = sum(employees.map((row) => row.avgifter))
  const filedAvgifter = Math.trunc(roundOre(totalGross * AVGIFTER_RATE))
  return {
    year,
    month,
    employees,
    totalGross,
    totalTax,
    totalAvgifter,
    filedAvgifter,
    totalNet: roundOre(totalGross - totalTax),
    payable: roundOre(totalTax + filedAvgifter),
  }
}

/** Earned vacation pay of the month: the owner has none. */
function vacationAccrualFor(plan: SimPlan, payroll: PayrollMonth): { accrual: number; avgifter: number } {
  let accrual = 0
  let avgifter = 0
  for (const row of payroll.employees) {
    if (plan.employees.find((employee) => employee.key === row.key)?.owner) continue
    const earned = roundOre(row.gross * VACATION_RATE)
    accrual = roundOre(accrual + earned)
    avgifter = roundOre(avgifter + roundOre(earned * AVGIFTER_RATE))
  }
  return { accrual, avgifter }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => roundOre(total + value), 0)
}

function daysBetween(fromInclusive: string, toInclusive: string): number {
  return Math.round((Date.parse(`${toInclusive}T12:00:00Z`) - Date.parse(`${fromInclusive}T12:00:00Z`)) / 86_400_000) + 1
}

/** Linear over the useful life, from the day of purchase, whole kronor per year. */
export function depreciationFor(asset: { date: string; cost: number; usefulLifeMonths: number }, year: number): number {
  const annual = (asset.cost * 12) / asset.usefulLifeMonths
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  if (asset.date > yearEnd) return 0
  const inService = asset.date > yearStart ? asset.date : yearStart
  return Math.round((annual * daysBetween(inService, yearEnd)) / daysBetween(yearStart, yearEnd))
}

export function computeAnswerKey(plan: SimPlan): AnswerKey {
  const ledger = new Map<Line, number>(LINES.map((line) => [line, 0]))
  const yearLedgers = new Map<number, Map<Line, number>>()
  const vat: Record<string, VatBoxes> = {}
  const payroll: Record<string, PayrollMonth> = {}
  const years: Record<number, YearFigures> = {}
  const corporateTax: Record<number, number> = {}
  const nonDeductible = new Map<number, number>()
  const sales = new Map<string, Extract<SimEvent, { type: 'sale' }>>()
  const purchases = new Map<string, Extract<SimEvent, { type: 'purchase' }>>()
  const assets: Array<Extract<SimEvent, { type: 'asset' }>> = []
  const supplierType = new Map(plan.suppliers.map((supplier) => [supplier.key, supplier.type]))
  const customerType = new Map(plan.customers.map((customer) => [customer.key, customer.type]))

  const boxes = (date: string) => (vat[vatKeyOf(date)] ??= emptyBoxes())
  const addBox = (date: string, box: Exclude<keyof VatBoxes, 'ruta49' | 'filedNet'>, amount: number) => {
    const row = boxes(date)
    row[box] = roundOre(row[box] + amount)
  }

  function post(date: string, what: string, amounts: Array<[Line, number]>): void {
    const year = Number(date.slice(0, 4))
    const balance = sum(amounts.map(([, amount]) => amount))
    if (balance !== 0) throw new Error(`the answer key does not balance on ${what}: ${balance}`)
    const yearLedger = yearLedgers.get(year) ?? new Map<Line, number>(LINES.map((line) => [line, 0]))
    yearLedgers.set(year, yearLedger)
    for (const [line, amount] of amounts) {
      ledger.set(line, roundOre((ledger.get(line) ?? 0) + amount))
      yearLedger.set(line, roundOre((yearLedger.get(line) ?? 0) + amount))
    }
  }

  const invoiceTotals = (lines: Array<{ net: number; vatRate: VatRate }>) => {
    const net = sum(lines.map((line) => line.net))
    const moms = sum(lines.map((line) => roundOre((line.net * line.vatRate) / 100)))
    return { net, moms, gross: roundOre(net + moms) }
  }
  const saleTotals = (sale: Extract<SimEvent, { type: 'sale' }>) =>
    invoiceTotals(sale.lines.map((line) => ({ net: line.quantity * line.unitPrice, vatRate: line.vatRate })))

  function bookSale(sale: Extract<SimEvent, { type: 'sale' }>, date: string, sign: 1 | -1): void {
    const { net, moms, gross } = saleTotals(sale)
    post(date, sale.id, [['receivables', sign * gross], ['revenue', -sign * net], ['vatLiability', -sign * moms]])
    for (const line of sale.lines) {
      const lineNet = line.quantity * line.unitPrice
      if (line.vatRate !== 0) {
        addBox(date, 'ruta05', sign * lineNet)
        addBox(date, OUTPUT_BOX[line.vatRate], sign * roundOre((lineNet * line.vatRate) / 100))
      } else {
        addBox(date, customerType.get(sale.customer) === 'eu_business' ? 'ruta39' : 'ruta40', sign * lineNet)
      }
    }
  }

  const yearResultBeforeTax = (year: number) => {
    const row = yearLedgers.get(year)
    return roundOre(
      -(row?.get('revenue') ?? 0) -
        (row?.get('externalCosts') ?? 0) -
        (row?.get('personnelCosts') ?? 0) -
        (row?.get('depreciation') ?? 0),
    )
  }

  function closeVatQuarter(year: number, quarter: number): VatBoxes {
    const row = (vat[vatKey(year, quarter)] ??= emptyBoxes())
    const output = [row.ruta10, row.ruta11, row.ruta12, row.ruta30]
    row.ruta49 = roundOre(sum(output) - row.ruta48)
    row.filedNet = sum(output.map(Math.trunc)) - Math.trunc(row.ruta48)
    return row
  }

  for (const [index, event] of plan.events.entries()) {
    const { date } = event
    const year = Number(date.slice(0, 4))
    switch (event.type) {
      case 'share_capital':
        post(date, event.type, [['cash', event.amount], ['shareCapital', -event.amount]])
        break
      case 'sale':
        sales.set(event.id, event)
        bookSale(event, date, 1)
        break
      case 'sale_payment': {
        const { gross } = saleTotals(sales.get(event.saleId)!)
        post(date, event.saleId, [['cash', gross], ['receivables', -gross]])
        break
      }
      case 'credit_note':
        bookSale(sales.get(event.saleId)!, date, -1)
        break
      case 'purchase': {
        purchases.set(event.id, event)
        const reverseCharge = supplierType.get(event.supplier) === 'eu_business'
        const { moms, gross } = invoiceTotals(event.lines)
        const costs = sum(event.lines.filter((line) => line.account !== '1220').map((line) => line.net))
        const assetCost = sum(event.lines.filter((line) => line.account === '1220').map((line) => line.net))
        post(date, event.id, [
          ['externalCosts', costs],
          ['tangibleAssets', assetCost],
          ['vatLiability', moms],
          ['supplierPayables', -gross],
        ])
        addBox(date, 'ruta48', moms)
        if (reverseCharge) {
          const reverseMoms = roundOre((costs * REVERSE_CHARGE_RATE) / 100)
          addBox(date, 'ruta21', costs)
          addBox(date, 'ruta30', reverseMoms)
          addBox(date, 'ruta48', reverseMoms)
        }
        break
      }
      case 'purchase_payment': {
        const { gross } = invoiceTotals(purchases.get(event.purchaseId)!.lines)
        post(date, event.purchaseId, [['supplierPayables', gross], ['cash', -gross]])
        break
      }
      case 'asset':
        assets.push(event)
        break
      case 'card_cost': {
        const { moms, gross } = invoiceTotals([{ net: event.net, vatRate: event.vatRate }])
        post(date, event.text, [['externalCosts', event.net], ['vatLiability', moms], ['cash', -gross]])
        addBox(date, 'ruta48', moms)
        if (event.category === 'expense_representation') {
          nonDeductible.set(year, roundOre((nonDeductible.get(year) ?? 0) + event.net))
        }
        break
      }
      case 'bank_fee':
        post(date, event.type, [['externalCosts', event.amount], ['cash', -event.amount]])
        break
      case 'payroll': {
        const month = payrollFor(plan, event.year, event.month)
        payroll[monthKey(event.year, event.month)] = month
        const vacation = vacationAccrualFor(plan, month)
        const vacationCost = roundOre(vacation.accrual + vacation.avgifter)
        post(date, `payroll ${event.year}-${event.month}`, [
          ['personnelCosts', roundOre(month.totalGross + month.totalAvgifter + vacationCost)],
          ['cash', -month.totalNet],
          ['payrollLiabilities', -month.payable],
          ['accruedVacation', -vacationCost],
          ['revenue', -roundOre(month.totalAvgifter - month.filedAvgifter)],
        ])
        break
      }
      case 'payroll_taxes_paid': {
        const { payable } = payroll[monthKey(event.year, event.month)]
        post(date, event.type, [['payrollLiabilities', payable], ['cash', -payable]])
        break
      }
      case 'vat_settlement': {
        const row = closeVatQuarter(event.year, event.quarter)
        // Öretal fall away when filed; the difference is the company's to keep or bear.
        const gap = roundOre(row.ruta49 - row.filedNet)
        post(date, event.type, [['vatLiability', gap], ['revenue', -gap]])
        break
      }
      case 'vat_paid': {
        const { filedNet } = vat[vatKey(event.year, event.quarter)]
        post(date, event.type, [['vatLiability', filedNet], ['cash', -filedNet]])
        break
      }
      case 'depreciation': {
        const amount = sum(assets.map((asset) => depreciationFor(asset, event.year)))
        post(date, event.type, [['depreciation', amount], ['tangibleAssets', -amount]])
        break
      }
      case 'corporate_tax': {
        const base = yearResultBeforeTax(event.year) + (nonDeductible.get(event.year) ?? 0)
        const flooredBase = Math.floor(Math.max(0, base) / 10) * 10
        const tax = Math.round(flooredBase * CORPORATE_TAX_RATE)
        corporateTax[event.year] = tax
        post(date, event.type, [['corporateTax', tax], ['corporateTaxLiability', -tax]])
        break
      }
      case 'corporate_tax_paid': {
        const tax = corporateTax[event.year]
        post(date, event.type, [['corporateTaxLiability', tax], ['cash', -tax]])
        break
      }
      case 'open_fiscal_year':
      case 'salary_change':
      case 'year_end':
      case 'annual_report':
        break
    }
    const next = plan.events[index + 1]
    if (!next || next.date.slice(0, 4) !== date.slice(0, 4)) {
      years[year] = yearFigures(year, ledger, yearLedgers, years, nonDeductible.get(year) ?? 0, corporateTax[year] ?? 0)
    }
  }
  return { vat, payroll, years, corporateTax }
}

function yearFigures(
  year: number,
  ledger: Map<Line, number>,
  yearLedgers: Map<number, Map<Line, number>>,
  years: Record<number, YearFigures>,
  nonDeductibleCosts: number,
  corporateTax: number,
): YearFigures {
  const of = (line: Line) => ledger.get(line) ?? 0
  const income = (line: Line) => yearLedgers.get(year)?.get(line) ?? 0
  const revenue = -income('revenue')
  const externalCosts = income('externalCosts')
  const personnelCosts = income('personnelCosts')
  const depreciation = income('depreciation')
  const resultBeforeTax = roundOre(revenue - externalCosts - personnelCosts - depreciation)
  const result = roundOre(resultBeforeTax - corporateTax)
  const retainedEarnings = roundOre(years[year - 1] ? years[year - 1].retainedEarnings + years[year - 1].result : 0)
  const tangibleAssets = of('tangibleAssets')
  const receivables = of('receivables')
  const cash = of('cash')
  const shareCapital = -of('shareCapital')
  const supplierPayables = -of('supplierPayables')
  const corporateTaxLiability = -of('corporateTaxLiability')
  const vatLiability = -of('vatLiability')
  const payrollLiabilities = -of('payrollLiabilities')
  const accruedVacation = -of('accruedVacation')
  return {
    year,
    revenue,
    externalCosts,
    personnelCosts,
    depreciation,
    resultBeforeTax,
    corporateTax,
    result,
    nonDeductibleCosts,
    taxBase: Math.floor(Math.max(0, resultBeforeTax + nonDeductibleCosts) / 10) * 10,
    tangibleAssets,
    receivables,
    cash,
    totalAssets: sum([tangibleAssets, receivables, cash]),
    shareCapital,
    retainedEarnings,
    supplierPayables,
    corporateTaxLiability,
    vatLiability,
    payrollLiabilities,
    accruedVacation,
    totalEquityAndLiabilities: sum([
      shareCapital,
      retainedEarnings,
      result,
      supplierPayables,
      corporateTaxLiability,
      vatLiability,
      payrollLiabilities,
      accruedVacation,
    ]),
  }
}
