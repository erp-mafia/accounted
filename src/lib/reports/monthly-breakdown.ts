import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'

export interface MonthlyBreakdownMonth {
  label: string
  income: number
  expenses: number
  net: number
}

export interface MonthlyBreakdown {
  months: MonthlyBreakdownMonth[]
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun',
  'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec',
]

/** Pre-summed month bucket for assembleMonthlyBreakdown. */
export interface MonthlyBucket {
  year: number
  /** 0-based month (JS Date convention, indexes MONTH_LABELS). */
  month0: number
  income: number
  expenses: number
}

/**
 * Pure assembly of the monthly breakdown from pre-summed buckets: month
 * range initialization, bucket fill, natural "YYYY-MM" sort, and Swedish
 * month labels. Extracted from generateMonthlyBreakdown so callers that
 * already hold per-month sums (e.g. the KPI route's single-round-trip
 * aggregate path) can reuse the assembly without re-scanning lines.
 *
 * Rounding happens once per bucket (income, expenses, then net over the
 * rounded pair) instead of the old incremental per-line rounding: equal
 * within float epsilon for real öre-denominated amounts.
 */
export function assembleMonthlyBreakdown(
  periodStart: string,
  periodEnd: string,
  buckets: MonthlyBucket[]
): MonthlyBreakdown {
  // Build monthly aggregates using year-aware keys ("2024-03", "2024-04",
  // etc.) to avoid data corruption for non-calendar fiscal years (Apr-Mar).
  const monthMap = new Map<string, { year: number; month: number; income: number; expenses: number }>()

  // Initialize all months in the period range
  const startDate = new Date(periodStart)
  const endDate = new Date(periodEnd)

  for (
    let y = startDate.getFullYear(), m = startDate.getMonth();
    y < endDate.getFullYear() || (y === endDate.getFullYear() && m <= endDate.getMonth());
    m === 11 ? (y++, m = 0) : m++
  ) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    monthMap.set(key, { year: y, month: m, income: 0, expenses: 0 })
  }

  for (const bucket of buckets) {
    const key = `${bucket.year}-${String(bucket.month0).padStart(2, '0')}`
    if (!monthMap.has(key)) {
      monthMap.set(key, { year: bucket.year, month: bucket.month0, income: 0, expenses: 0 })
    }
    const target = monthMap.get(key)!
    target.income += bucket.income
    target.expenses += bucket.expenses
  }

  // Convert to sorted array (keys sort naturally as "YYYY-MM")
  const months: MonthlyBreakdownMonth[] = []
  const sortedKeys = Array.from(monthMap.keys()).sort()

  for (const key of sortedKeys) {
    const data = monthMap.get(key)!
    const income = roundOre(data.income)
    const expenses = roundOre(data.expenses)
    months.push({
      label: MONTH_LABELS[data.month],
      income,
      expenses,
      net: roundOre(income - expenses),
    })
  }

  return { months }
}

/**
 * Generate monthly income vs expenses breakdown for a fiscal period.
 *
 * Groups posted AND reversed journal entry lines by month and account class:
 * - Class 3 (30xx) = revenue (credit side)
 * - Class 4-7 (40xx-79xx) = expenses (debit side)
 *
 * Reversed originals are included on purpose (issue #2201): the year total
 * (tb_ex_year_end / the income statement) counts posted + reversed, so a
 * same-year storno nets to 0 there. Dropping the reversed original here but
 * keeping the storno (itself posted) made the months stop summing to
 * Nettoresultat. The same entry set on both paths keeps sum(months) = year.
 *
 * Year-end entries are excluded, including the storno/correction chain of a
 * REVERSED year-end entry (an undone bokslut). Without that the resultatavslut,
 * which posts the mirror image of every P&L account, showed the whole year's
 * revenue as negative income in the fiscal-year-end month: measured on
 * production as 28 companies affected, worst case a single month understated by
 * 10 347 472 kr. Mirrors tb_ex_ye_entries in get_kpi_report_aggregates, which
 * serves the same chart on the no-dimension hot path; the two must agree.
 */
export async function generateMonthlyBreakdown(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: {
    /** SIE dim → code filter ({"6":"P001"}). Without it a dimension-scoped
     *  KPI view would silently chart company-wide months. */
    dimensions?: Record<string, string>
  }
): Promise<MonthlyBreakdown> {

  // Get the fiscal period date range
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    return { months: [] }
  }

  // Ids of REVERSED year-end entries, company-wide (no period filter): a storno
  // in this period can reverse a year-end entry from another period. Mirrors the
  // wave-1 fetch in lib/reports/trial-balance.ts and ye_reversed in
  // get_kpi_report_aggregates.
  const reversedYearEndIds = (
    await fetchAllRows<{ id: string }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .eq('source_type', 'year_end')
        .eq('status', 'reversed')
        .order('id', { ascending: true })
        .range(from, to)
    )
  ).map((r) => r.id)

  // Get all posted and reversed journal entry lines for this period with their
  // entry dates, via the two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lines: any[]
  try {
    lines = await fetchEntryLines({
      supabase,
      entryColumns: 'entry_date, status, company_id, fiscal_period_id',
      lineColumns: 'account_number, debit_amount, credit_amount',
      filterEntries: (q: EntryLinesQuery) => {
        let query = q
          .eq('fiscal_period_id', fiscalPeriodId)
          .eq('company_id', companyId)
          // posted + reversed: the same set as tb_ex_ye_entries in the RPC.
          .in('status', ['posted', 'reversed'])
          .neq('source_type', 'year_end')
        if (reversedYearEndIds.length > 0) {
          const idList = `(${reversedYearEndIds.join(',')})`
          query = query.or(`reverses_id.is.null,reverses_id.not.in.${idList}`)
          query = query.or(`correction_of_id.is.null,correction_of_id.not.in.${idList}`)
        }
        return query
      },
      filterLines:
        options?.dimensions && Object.keys(options.dimensions).length > 0
          ? // jsonb containment (@>): served by idx_jel_dimensions_gin.
            (q: EntryLinesQuery) => q.contains('dimensions', options.dimensions)
          : undefined,
      // The old embed was aliased: journal_entry:journal_entries!inner(...).
      attachEntriesAs: 'journal_entry',
    })
  } catch {
    return { months: [] }
  }

  // Sum lines into per-month buckets (raw sums; assembleMonthlyBreakdown
  // rounds once per bucket), keyed year-aware for non-calendar fiscal years.
  const bucketMap = new Map<string, MonthlyBucket>()

  for (const line of lines) {
    const entry = line.journal_entry as {
      entry_date: string
      status: string
      company_id: string
      fiscal_period_id: string
    }
    const accountClass = parseInt(line.account_number.charAt(0))
    const entryDate = new Date(entry.entry_date)
    const key = `${entryDate.getFullYear()}-${String(entryDate.getMonth()).padStart(2, '0')}`

    let bucket = bucketMap.get(key)
    if (!bucket) {
      bucket = { year: entryDate.getFullYear(), month0: entryDate.getMonth(), income: 0, expenses: 0 }
      bucketMap.set(key, bucket)
    }

    if (accountClass === 3) {
      // Revenue accounts: credit side represents revenue
      bucket.income += line.credit_amount - line.debit_amount
    } else if (accountClass >= 4 && accountClass <= 7) {
      // Expense accounts: debit side represents expenses
      bucket.expenses += line.debit_amount - line.credit_amount
    } else if (accountClass === 8 && line.account_number !== '8999') {
      // Financial items (class 8): interest, exchange gains/losses, etc.
      // 8999 "Årets resultat" is a year-end closing account: its debit/credit
      // mirrors the computed profit, so including it here would cancel the
      // period's income-vs-expense signal on the month of closing.
      const amount = line.credit_amount - line.debit_amount
      if (amount >= 0) {
        bucket.income += amount
      } else {
        bucket.expenses += Math.abs(amount)
      }
    }
  }

  return assembleMonthlyBreakdown(
    period.period_start,
    period.period_end,
    Array.from(bucketMap.values())
  )
}
