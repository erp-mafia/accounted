import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Arbetsgivaravgiftsunderlag: Employer contribution basis report.
 *
 * Monthly breakdown by avgifter rate category:
 * - Standard (31.42%)
 * - Reduced 65+ (10.21%)
 * - Youth (20.81%, Apr 2026-Sep 2027)
 * - Växa-stöd (10.21%)
 *
 * Used for reconciling against AGI filings (Ruta 060-062)
 * and verifying correct avgifter calculations per social-charges.md.
 *
 * Per BFL: Part of räkenskapsinformation, 7-year retention.
 */

export interface AvgifterBasisRow {
  periodYear: number
  periodMonth: number
  category: string
  categoryLabel: string
  rate: number
  basis: number        // Underlag (sum of avgifter_basis for employees in this category)
  amount: number       // Avgift (basis × rate)
  employeeCount: number
}

export interface AvgifterBasisReport {
  rows: AvgifterBasisRow[]
  totals: {
    totalBasis: number
    totalAmount: number
  }
  year: number
}

const CATEGORY_LABELS: Record<string, string> = {
  standard: 'Standard (31,42%)',
  reduced_65plus: 'Reducerad 67+ (10,21%)',
  youth: 'Ungdomsrabatt (20,81%)',
  vaxa_stod: 'Växa-stöd (10,21%)',
  exempt: 'Undantagen (0%)',
}

/**
 * Generate avgifter basis report for a year.
 */
export async function generateAvgifterBasis(
  supabase: SupabaseClient,
  companyId: string,
  year: number
): Promise<AvgifterBasisReport> {
  const r = (x: number) => Math.round(x * 100) / 100

  // Load all salary run employees for booked runs this year.
  // Paginated with a stable id order: a multi-year/high-headcount company can
  // exceed PostgREST's 1000-row cap, and a silent truncation here would
  // under-report the arbetsgivaravgifter basis reconciled against AGI filings.
  const runEmployees = await fetchAllRows<{
    id: string
    avgifter_basis: number
    avgifter_amount: number
    avgifter_rate: number
    // PostgREST's type-level select parser models an embedded resource as an
    // array, so keep this `unknown` (the rows are read via an explicit cast
    // below) to stay assignable regardless of postgrest-js version.
    salary_run: unknown
  }>(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select(`
        id,
        avgifter_basis,
        avgifter_amount,
        avgifter_rate,
        salary_run:salary_runs!inner(period_year, period_month, status)
      `)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to)
  , { dedupeBy: (e) => e.id })

  // Filter to booked runs for the year
  const bookedForYear = runEmployees.filter(sre => {
    const run = sre.salary_run as unknown as { period_year: number; period_month: number; status: string } | null
    return run && run.period_year === year && run.status === 'booked'
  })

  // Group by month + rate category
  const grouped = new Map<string, {
    periodYear: number
    periodMonth: number
    category: string
    rate: number
    basis: number
    amount: number
    count: number
  }>()

  for (const sre of bookedForYear) {
    const run = sre.salary_run as unknown as { period_year: number; period_month: number }
    const category = rateToCategory(sre.avgifter_rate)
    const key = `${run.period_month}-${category}`

    const current = grouped.get(key) || {
      periodYear: year,
      periodMonth: run.period_month,
      category,
      rate: sre.avgifter_rate,
      basis: 0,
      amount: 0,
      count: 0,
    }
    current.basis += sre.avgifter_basis
    current.amount += sre.avgifter_amount
    current.count++
    grouped.set(key, current)
  }

  const rows: AvgifterBasisRow[] = Array.from(grouped.values())
    .map(g => ({
      periodYear: g.periodYear,
      periodMonth: g.periodMonth,
      category: g.category,
      categoryLabel: CATEGORY_LABELS[g.category] || g.category,
      rate: g.rate,
      basis: r(g.basis),
      amount: r(g.amount),
      employeeCount: g.count,
    }))
    .sort((a, b) => a.periodMonth - b.periodMonth || a.category.localeCompare(b.category))

  const totals = {
    totalBasis: r(rows.reduce((s, row) => s + row.basis, 0)),
    totalAmount: r(rows.reduce((s, row) => s + row.amount, 0)),
  }

  return { rows, totals, year }
}

function rateToCategory(rate: number): string {
  if (rate === 0) return 'exempt'
  if (rate <= 0.1022) return 'reduced_65plus' // 10.21% ± rounding
  if (rate <= 0.2082) return 'youth'           // 20.81%
  return 'standard'                            // 31.42%
}
