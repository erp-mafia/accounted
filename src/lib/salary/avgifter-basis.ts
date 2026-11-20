import type { SupabaseClient } from '@supabase/supabase-js'
import { agiReportingPeriod } from '@/lib/salary/agi/reporting-period'
import {
  declaredAvgifterForRun,
  type DeclaredAvgifterCategory,
  type DeclaredAvgifterRunRow,
} from '@/lib/salary/declared-avgifter'
import { regionalSupportForRun } from '@/lib/salary/regional-support'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Arbetsgivaravgiftsunderlag: the avgifter the arbetsgivardeklarationer declare
 * for a year, month by month and per sats:
 * - Standard (31.42%)
 * - Reduced 67+ (10.21%)
 * - Youth (20.81%, Apr 2026-Sep 2027)
 *
 * Växa-stöd is no category: since Lag (2025:1334) it is a refund applied for
 * after filing, and the avgifter are declared at the employee's full sats.
 *
 * A reconciliation against the AGI is only worth what it shares with it, so
 * the figures are the AGI's own computation, run by run
 * (declaredAvgifterForRun): the stored category, the youth cap split, the
 * overrides, F-skatt and borttag, whole kronor per sats. Pay belongs to the
 * month the AGI files it, the payment date. An exempt employee (born 1937 or
 * earlier) has no row: the AGI declares no avgift for them.
 *
 * Per BFL: Part of räkenskapsinformation, 7-year retention.
 */

export interface AvgifterBasisRow {
  periodYear: number
  periodMonth: number
  category: string
  categoryLabel: string
  rate: number
  basis: number        // Underlag declared in this category (whole kronor)
  amount: number       // Avgift declared in this category (whole kronor)
  employeeCount: number
}

export interface AvgifterBasisReport {
  rows: AvgifterBasisRow[]
  totals: {
    totalBasis: number
    /** The year's FK487, after regional support. */
    totalAmount: number
    /** Regionalt stöd taken off the rows' avgifter in the declarations (FK476). */
    regionalSupportDeduction: number
  }
  year: number
}

const CATEGORY: Record<DeclaredAvgifterCategory, { key: string; label: string; rateParam: string }> = {
  standard: { key: 'standard', label: 'Standard (31,42%)', rateParam: 'avgifterTotal' },
  reduced65plus: { key: 'reduced_65plus', label: 'Reducerad 67+ (10,21%)', rateParam: 'avgifterReduced65plus' },
  youth: { key: 'youth', label: 'Ungdomsrabatt (20,81%)', rateParam: 'avgifterYouthRate' },
}

type ReportRun = {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  status: string
  calculation_params: Record<string, unknown> | null
}

type RosterRow = DeclaredAvgifterRunRow & { id: string; salary_run: unknown }

/**
 * Generate avgifter basis report for a year: the booked runs whose AGI period
 * falls in it.
 */
export async function generateAvgifterBasis(
  supabase: SupabaseClient,
  companyId: string,
  year: number
): Promise<AvgifterBasisReport> {
  // Paginated with a stable id order: a multi-year/high-headcount company can
  // exceed PostgREST's 1000-row cap, and a silent truncation here would
  // under-report the arbetsgivaravgifter basis reconciled against AGI filings.
  const runEmployees = await fetchAllRows<RosterRow>(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(`
        id,
        avgifter_basis,
        avgifter_basis_override,
        avgifter_amount_override,
        avgifter_rate,
        avgifter_category,
        removed_from_agi,
        employee:employees(f_skatt_status),
        salary_run:salary_runs!inner(id, period_year, period_month, payment_date, status, calculation_params)
      `)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: RosterRow[] | null; error: { message: string } | null }>
  , { dedupeBy: (e) => e.id })

  const byRun = new Map<string, { run: ReportRun; rows: RosterRow[] }>()
  for (const sre of runEmployees) {
    const run = sre.salary_run as ReportRun | null
    if (!run || run.status !== 'booked' || agiReportingPeriod(run).periodYear !== year) continue
    const group = byRun.get(run.id)
    if (group) group.rows.push(sre)
    else byRun.set(run.id, { run, rows: [sre] })
  }

  const grouped = new Map<string, AvgifterBasisRow>()
  let regionalSupportDeduction = 0

  for (const { run, rows } of byRun.values()) {
    const { periodMonth } = agiReportingPeriod(run)
    const params = run.calculation_params
    regionalSupportDeduction += regionalSupportForRun(rows, params)?.deduction ?? 0
    const categories = Object.entries(declaredAvgifterForRun(rows, params).byCategory) as Array<
      [DeclaredAvgifterCategory, { basis: number; amount: number }]
    >
    for (const [category, declared] of categories) {
      const { key, label, rateParam } = CATEGORY[category]
      const groupKey = `${periodMonth}-${key}`
      const current = grouped.get(groupKey) ?? {
        periodYear: year,
        periodMonth,
        category: key,
        categoryLabel: label,
        rate: Number(params?.[rateParam]) || 0,
        basis: 0,
        amount: 0,
        employeeCount: 0,
      }
      current.basis += declared.basis
      current.amount += declared.amount
      // Asked of the same computation: a youth payslip over the cap counts in both rows.
      current.employeeCount += rows.filter((row) => declaredAvgifterForRun([row], params).byCategory[category]).length
      grouped.set(groupKey, current)
    }
  }

  const rows = [...grouped.values()].sort(
    (a, b) => a.periodMonth - b.periodMonth || a.category.localeCompare(b.category),
  )

  return {
    rows,
    totals: {
      totalBasis: rows.reduce((sum, row) => sum + row.basis, 0),
      totalAmount: rows.reduce((sum, row) => sum + row.amount, 0) - regionalSupportDeduction,
      regionalSupportDeduction,
    },
    year,
  }
}
