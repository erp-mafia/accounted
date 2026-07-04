import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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

/**
 * Generate monthly income vs expenses breakdown for a fiscal period.
 *
 * Groups posted journal entry lines by month and account class:
 * - Class 3 (30xx) = revenue (credit side)
 * - Class 4-7 (40xx-79xx) = expenses (debit side)
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

  // Get all posted journal entry lines for this period with their entry dates
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lines: any[]
  try {
    lines = await fetchAllRows(({ from, to }) => {
      let query = supabase
        .from('journal_entry_lines')
        .select(`
          account_number,
          debit_amount,
          credit_amount,
          journal_entry:journal_entries!inner(
            entry_date,
            status,
            company_id,
            fiscal_period_id
          )
        `)
        .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
        .eq('journal_entries.company_id', companyId)
        .eq('journal_entries.status', 'posted')

      if (options?.dimensions && Object.keys(options.dimensions).length > 0) {
        // jsonb containment (@>): served by idx_jel_dimensions_gin.
        query = query.contains('dimensions', options.dimensions)
      }

      // Stable total order for correct paging (see fetch-all.ts).
      return query.order('id', { ascending: true }).range(from, to)
    })
  } catch {
    return { months: [] }
  }

  // Build monthly aggregates using year-aware keys ("2024-03", "2024-04", etc.)
  // to avoid data corruption for non-calendar fiscal years (e.g., Apr-Mar)
  const monthMap = new Map<string, { year: number; month: number; income: number; expenses: number }>()

  // Initialize all months in the period range
  const startDate = new Date(period.period_start)
  const endDate = new Date(period.period_end)

  for (
    let y = startDate.getFullYear(), m = startDate.getMonth();
    y < endDate.getFullYear() || (y === endDate.getFullYear() && m <= endDate.getMonth());
    m === 11 ? (y++, m = 0) : m++
  ) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    monthMap.set(key, { year: y, month: m, income: 0, expenses: 0 })
  }

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

    if (!monthMap.has(key)) {
      monthMap.set(key, { year: entryDate.getFullYear(), month: entryDate.getMonth(), income: 0, expenses: 0 })
    }

    const bucket = monthMap.get(key)!

    if (accountClass === 3) {
      // Revenue accounts: credit side represents revenue
      bucket.income = Math.round((bucket.income + line.credit_amount - line.debit_amount) * 100) / 100
    } else if (accountClass >= 4 && accountClass <= 7) {
      // Expense accounts: debit side represents expenses
      bucket.expenses = Math.round((bucket.expenses + line.debit_amount - line.credit_amount) * 100) / 100
    } else if (accountClass === 8 && line.account_number !== '8999') {
      // Financial items (class 8): interest, exchange gains/losses, etc.
      // 8999 "Årets resultat" is a year-end closing account: its debit/credit
      // mirrors the computed profit, so including it here would cancel the
      // period's income-vs-expense signal on the month of closing.
      const amount = line.credit_amount - line.debit_amount
      if (amount >= 0) {
        bucket.income = Math.round((bucket.income + amount) * 100) / 100
      } else {
        bucket.expenses = Math.round((bucket.expenses + Math.abs(amount)) * 100) / 100
      }
    }
  }

  // Convert to sorted array (keys sort naturally as "YYYY-MM")
  const months: MonthlyBreakdownMonth[] = []
  const sortedKeys = Array.from(monthMap.keys()).sort()

  for (const key of sortedKeys) {
    const data = monthMap.get(key)!
    months.push({
      label: MONTH_LABELS[data.month],
      income: data.income,
      expenses: data.expenses,
      net: Math.round((data.income - data.expenses) * 100) / 100,
    })
  }

  return { months }
}
