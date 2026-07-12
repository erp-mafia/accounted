/**
 * Shared PayslipData assembly.
 *
 * The per-employee PDF route and the payslip send/link surfaces must render
 * identical payslips — override coalescing, breakdown steps and masking live
 * here so the logic can't drift between callers.
 */
import type { PayslipData, PayslipLineItem } from '@/lib/salary/pdf/payslip-template'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'

const EMPLOYMENT_LABELS: Record<string, string> = {
  employee: 'Anställd',
  company_owner: 'Företagsledare',
  board_member: 'Styrelseledamot',
}

export interface PayslipRunSource {
  period_year: number
  period_month: number
  payment_date: string
}

export interface PayslipEmployeeSource {
  first_name: string
  last_name: string
  personnummer: string
  employment_type: string
  tax_table_number: number | null
  tax_column: number
  clearing_number: string | null
  bank_account_number: string | null
}

/** salary_run_employees row with joined line_items — loose shape by design
 * (the callers select `*`), narrowed field-by-field below. */
export type PayslipSreSource = Record<string, unknown> & {
  line_items?: Array<Record<string, unknown>> | null
}

export function buildPayslipData(params: {
  run: PayslipRunSource
  sre: PayslipSreSource
  employee: PayslipEmployeeSource
  company: { name: string; org_number: string | null }
}): PayslipData {
  const { run, sre, employee: emp, company } = params

  const lineItems: PayslipLineItem[] = ((sre.line_items || []) as Array<Record<string, unknown>>)
    .sort((a, b) => ((a.sort_order as number) || 0) - ((b.sort_order as number) || 0))
    .map(li => ({
      description: li.description as string,
      quantity: li.quantity as number | undefined,
      unitPrice: li.unit_price as number | undefined,
      amount: li.amount as number,
    }))

  let taxReference = 'Schablon 30%'
  if (emp.tax_table_number) {
    taxReference = `Tabell ${emp.tax_table_number}, kol ${emp.tax_column}`
  }

  // Engine-computed breakdown rows stay for transparency; manual override
  // rows are appended so the breakdown matches the displayed totals.
  const breakdown = sre.calculation_breakdown as {
    steps?: Array<{ label: string; formula: string; output: number }>
  } | null
  const baseSteps = breakdown?.steps ?? []
  const overrideSteps: Array<{ label: string; formula: string; output: number }> = []
  const reason = (sre.override_reason as string | null) || 'manuell justering'
  if (sre.tax_withheld_override !== null && sre.tax_withheld_override !== undefined) {
    overrideSteps.push({
      label: 'Manuell justering: Skatteavdrag',
      formula: reason,
      output: Number(sre.tax_withheld_override),
    })
  }
  if (sre.avgifter_basis_override !== null && sre.avgifter_basis_override !== undefined) {
    overrideSteps.push({
      label: 'Manuell justering: Avgiftsunderlag',
      formula: reason,
      output: Number(sre.avgifter_basis_override),
    })
  }
  if (sre.avgifter_amount_override !== null && sre.avgifter_amount_override !== undefined) {
    overrideSteps.push({
      label: 'Manuell justering: Arbetsgivaravgifter',
      formula: reason,
      output: Number(sre.avgifter_amount_override),
    })
  }
  const breakdownSteps = baseSteps.length > 0 || overrideSteps.length > 0
    ? [...baseSteps, ...overrideSteps]
    : undefined

  let bankAccount: string | undefined
  if (emp.clearing_number && emp.bank_account_number) {
    const lastDigits = emp.bank_account_number.slice(-4)
    bankAccount = `${emp.clearing_number}-****${lastDigits}`
  }

  // Honor advanced-mode per-employee overrides so the employee sees the same
  // effective values that are booked and AGI-reported.
  const grossSalary = sre.gross_salary as number
  const taxWithheld = sre.tax_withheld as number
  const effectiveTax = (sre.tax_withheld_override as number | null) ?? taxWithheld
  const effectiveAvgifter =
    (sre.avgifter_amount_override as number | null) ?? (sre.avgifter_amount as number)
  const effectiveNet = (sre.net_salary as number) + (taxWithheld - effectiveTax)
  const vacationAccrual = sre.vacation_accrual as number
  const vacationAccrualAvgifter = sre.vacation_accrual_avgifter as number

  return {
    companyName: company.name,
    companyOrgNumber: company.org_number || '',
    employeeName: `${emp.first_name} ${emp.last_name}`,
    personnummerMasked: maskPersonnummer(decryptPersonnummer(emp.personnummer)),
    employmentType: EMPLOYMENT_LABELS[emp.employment_type] || emp.employment_type,
    periodYear: run.period_year,
    periodMonth: run.period_month,
    paymentDate: run.payment_date,
    lineItems,
    grossSalary,
    taxWithheld: effectiveTax,
    netSalary: effectiveNet,
    taxReference,
    avgifterRate: sre.avgifter_rate as number,
    avgifterAmount: effectiveAvgifter,
    vacationAccrual,
    vacationAccrualAvgifter,
    totalEmployerCost: grossSalary + effectiveAvgifter + vacationAccrual + vacationAccrualAvgifter,
    ytdGross: sre.ytd_gross as number,
    ytdTax: sre.ytd_tax as number,
    ytdNet: sre.ytd_net as number,
    bankAccount,
    breakdownSteps,
  }
}

export function payslipFileName(
  run: PayslipRunSource,
  emp: Pick<PayslipEmployeeSource, 'first_name' | 'last_name'>,
): string {
  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  return `lonespec_${emp.last_name}_${emp.first_name}_${periodLabel}.pdf`
}
