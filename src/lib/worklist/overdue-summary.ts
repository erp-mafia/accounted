import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { invoiceDaysOverdue } from '@/lib/invoices/overdue'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { sumOre } from '@/lib/money'
import type { OverdueInvoicesDue } from './types'

/**
 * The overdue customer invoices' facts as one figure (pure, browser-safe):
 * the Att göra row, the MCP attention resource and the Viktiga datum note
 * read the same count and amount from the rows filterOverdueInvoices
 * (lib/invoices/overdue.ts) returns. Its own module so a client page can
 * use it without pulling in the worklist's server queries.
 */

/** The columns the summary reads off each overdue invoice. */
export interface OverdueSummaryRow {
  /** YYYY-MM-DD. */
  due_date: string
  total: number | string | null
  total_sek: number | string | null
  remaining_amount: number | string | null
  currency: string | null
}

/**
 * The grouped row's facts from the overdue rows. A SEK invoice adds its
 * remaining_amount; one in another currency adds the same share of its
 * stored total_sek (the rate it was booked at), or, without one, is counted
 * in unconverted_count instead of mixing currencies into the sum.
 */
export function summarizeOverdueInvoices(
  rows: ReadonlyArray<OverdueSummaryRow>,
  today: string = todayIsoStockholm(),
): OverdueInvoicesDue | null {
  if (rows.length === 0) return null
  const amounts: number[] = []
  let unconverted = 0
  let oldest = rows[0].due_date
  for (const row of rows) {
    if (row.due_date < oldest) oldest = row.due_date
    const remaining = Number(row.remaining_amount ?? row.total ?? 0)
    if (isLedgerCurrency(row.currency)) {
      amounts.push(remaining)
      continue
    }
    const total = Number(row.total ?? 0)
    if (row.total_sek == null || total === 0) {
      unconverted++
      continue
    }
    amounts.push((Number(row.total_sek) * remaining) / total)
  }
  return {
    count: rows.length,
    remaining_sek: sumOre(amounts),
    unconverted_count: unconverted,
    oldest_due_date: oldest,
    oldest_days_overdue: invoiceDaysOverdue(oldest, today),
  }
}
