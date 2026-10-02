/**
 * Shared PayslipData assembly.
 *
 * The per-employee PDF route and the payslip send/link surfaces must render
 * identical payslips — override coalescing, breakdown steps and masking live
 * here so the logic can't drift between callers.
 *
 * The one deliberate difference is the audience. The employer's own view of
 * a payslip (the dashboard "view payslip" link) always carries every section.
 * The copy the employee receives (the emailed token link, the bulk ZIP the
 * employer hands out, the v1 API download) follows the company's
 * salary_payslip_show_employer_cost / salary_payslip_show_breakdown switches
 * until the run's payslips are issued to employees; from then on it follows
 * the sections fixed on the run (salary_runs.payslip_show_*, written once by
 * lib/salary/payslips/section-snapshot), so a payslip already handed out keeps
 * the content it had (BFL 7 kap. 1 §). Callers say which copy they render;
 * this module never guesses it.
 */
import type { PayslipData, PayslipLineItem } from '@/lib/salary/pdf/payslip-template'
import { hasCustomDeviationWindow, runDeviationWindow } from '@/lib/salary/deviation-period'
import { decryptPersonnummer, maskPersonnummer } from '@/lib/salary/personnummer'
import { VAXA_STOD_REFUND_STEP_LABEL } from '@/lib/salary/vaxa-stod'

const EMPLOYMENT_LABELS: Record<string, string> = {
  employee: 'Anställd',
  company_owner: 'Företagsledare',
  board_member: 'Styrelseledamot',
}

/**
 * The sections a run's employee copy was issued with (migration
 * 20260930200000). All null until the payslips first go to employees; the
 * database keeps them unchanged once set.
 */
export interface PayslipSectionSnapshot {
  payslip_sections_issued_at?: string | null
  payslip_show_employer_cost?: boolean | null
  payslip_show_breakdown?: boolean | null
}

export interface PayslipRunSource extends PayslipSectionSnapshot {
  period_year: number
  period_month: number
  payment_date: string
  deviation_period_start?: string | null
  deviation_period_end?: string | null
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

/** The company_settings switches for the employee copy. A company without a
 * settings row (null) gets the column defaults: both sections printed. */
export interface PayslipSectionSettings {
  salary_payslip_show_employer_cost?: boolean | null
  salary_payslip_show_breakdown?: boolean | null
}

/**
 * Who the rendered payslip is for. The employer view needs no settings; the
 * employee copy cannot be built without them, so a caller cannot forget to
 * read the switches.
 */
export type PayslipAudience =
  | { kind: 'employer' }
  | { kind: 'employee'; settings: PayslipSectionSettings | null }

export interface PayslipSections {
  employerCost: boolean
  breakdown: boolean
}

/**
 * The dashboard PDF route's `?audience=` query parameter. Absent means the
 * employer's own view; `employee` is the copy the employer hands out (the
 * bulk ZIP). Anything else is null so the route can refuse it instead of
 * silently rendering a copy the caller did not ask for.
 */
export function parsePayslipAudienceParam(value: string | null): 'employer' | 'employee' | null {
  if (value === null || value === '' || value === 'employer') return 'employer'
  if (value === 'employee') return 'employee'
  return null
}

/**
 * The sections fixed on a run when its payslips were issued, or null when
 * they have not been issued yet. The breakdown rule below holds here too
 * (the database refuses a snapshot that breaks it; this keeps a hand-built
 * row honest).
 */
export function issuedPayslipSections(run: PayslipSectionSnapshot | null | undefined): PayslipSections | null {
  if (!run?.payslip_sections_issued_at) return null
  const employerCost = run.payslip_show_employer_cost ?? true
  return { employerCost, breakdown: employerCost && (run.payslip_show_breakdown ?? true) }
}

/**
 * Which optional sections a copy for this audience prints.
 *
 * The employee copy of a run that has been issued prints what it was issued
 * with, whatever the switches say now; before that it follows the switches.
 *
 * Hiding the employer cost also hides Beräkningsunderlag: the engine's steps
 * carry the employer cost figures (Arbetsgivaravgifter, Semesteravsättning,
 * Total arbetsgivarkostnad, avgift overrides) and stored steps have no
 * category to filter them by, so a breakdown without them cannot be built
 * reliably from historical runs. Showing the breakdown therefore requires
 * showing the employer cost.
 */
export function payslipSectionsFor(
  audience: PayslipAudience,
  run?: PayslipSectionSnapshot | null,
): PayslipSections {
  if (audience.kind === 'employer') return { employerCost: true, breakdown: true }
  const issued = issuedPayslipSections(run)
  if (issued) return issued
  const employerCost = audience.settings?.salary_payslip_show_employer_cost ?? true
  return {
    employerCost,
    breakdown: employerCost && (audience.settings?.salary_payslip_show_breakdown ?? true),
  }
}

/**
 * The tax table line printed on the payslip: the table and column the run
 * was calculated with, not the ones on the employee today.
 *
 * The engine writes the reference it used onto the run row
 * (salary_run_employees.tax_table_number / tax_column / tax_table_year, at
 * run creation and again at every calculation), so a payslip downloaded
 * after the employee moved to another table still names the table the tax
 * was withheld under (BFL 7 kap. 1 §). A run row with none of the three set
 * predates the snapshot and falls back to the employee. A snapshot without a
 * table number means the run was taxed without one: it prints Schablon 30%
 * even if the employee has a table now. The column falls back to 1 the same
 * way the engine does (run-calculation: `emp.tax_column || 1`).
 */
export function payslipTaxReference(
  sre: PayslipSreSource,
  emp: Pick<PayslipEmployeeSource, 'tax_table_number' | 'tax_column'>,
): string {
  const runTable = sre.tax_table_number as number | null | undefined
  const runColumn = sre.tax_column as number | null | undefined
  const runYear = sre.tax_table_year as number | null | undefined
  const hasRunSnapshot = runTable != null || runColumn != null || runYear != null

  const table = hasRunSnapshot ? runTable : emp.tax_table_number
  const column = hasRunSnapshot ? runColumn : emp.tax_column
  if (!table) return 'Schablon 30%'
  return `Tabell ${table}, kol ${column || 1}`
}

export function buildPayslipData(params: {
  run: PayslipRunSource
  sre: PayslipSreSource
  employee: PayslipEmployeeSource
  company: { name: string; org_number: string | null }
  audience: PayslipAudience
}): PayslipData {
  const { run, sre, employee: emp, company } = params
  const sections = payslipSectionsFor(params.audience, run)

  const lineItems: PayslipLineItem[] = ((sre.line_items || []) as Array<Record<string, unknown>>)
    .sort((a, b) => ((a.sort_order as number) || 0) - ((b.sort_order as number) || 0))
    .map(li => ({
      // A line taxed at a flat engångsskatt says so on the payslip: the
      // "Preliminär skatt" total then differs from the table amount and the
      // breakdown's "Engångsskatt (x %)" step explains the difference.
      description:
        li.one_off_tax_percent !== null && li.one_off_tax_percent !== undefined
          ? `${li.description as string} (engångsskatt ${li.one_off_tax_percent as number} %)`
          : (li.description as string),
      quantity: li.quantity as number | undefined,
      unitPrice: li.unit_price as number | undefined,
      amount: li.amount as number,
    }))

  const taxReference = payslipTaxReference(sre, emp)

  // Engine-computed breakdown rows stay for transparency; manual override
  // rows are appended so the breakdown matches the displayed totals. The
  // växa-stöd refund note is left out: it tells the employer to apply to
  // Skatteverket and changes nothing on the employee's pay.
  const breakdown = sre.calculation_breakdown as {
    steps?: Array<{ label: string; formula: string; output: number }>
  } | null
  const baseSteps = (breakdown?.steps ?? []).filter((step) => step.label !== VAXA_STOD_REFUND_STEP_LABEL)
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
  const breakdownSteps = sections.breakdown && (baseSteps.length > 0 || overrideSteps.length > 0)
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
    // Only printed when the deductions come from another month than the
    // salary: the employee otherwise cannot tell why August's sick day sits
    // on the September payslip.
    deviationPeriodLabel: hasCustomDeviationWindow(run)
      ? `${runDeviationWindow(run).start} - ${runDeviationWindow(run).end}`
      : null,
    lineItems,
    grossSalary,
    taxWithheld: effectiveTax,
    netSalary: effectiveNet,
    taxReference,
    employerCost: sections.employerCost
      ? {
          avgifterRate: sre.avgifter_rate as number,
          avgifterAmount: effectiveAvgifter,
          vacationAccrual,
          vacationAccrualAvgifter,
          totalEmployerCost: grossSalary + effectiveAvgifter + vacationAccrual + vacationAccrualAvgifter,
        }
      : null,
    ytdGross: sre.ytd_gross as number,
    ytdTax: sre.ytd_tax as number,
    ytdNet: sre.ytd_net as number | null,
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
