/**
 * Forecast rows (cash_forecast_rows): money someone expects that the books do
 * not hold yet. An open row counts on its date while that date is today or
 * later; a row dated before today leaves the projection (it either happened,
 * and its bank row will realise it, or it did not). A row linked to an
 * invoice or supplier invoice yields to it: the invoice counts, as a
 * receivable or payable, or is already paid and in the balance.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { CashFlow, ForecastCaveat, ForecastConfidence, ForecastWindow } from '../types'

export interface ForecastRowForProjection {
  id: string
  expected_date: string
  amount: number | string
  direction: 'in' | 'out'
  category: string
  confidence: ForecastConfidence
  invoice_id: string | null
  supplier_invoice_id: string | null
  external_source: string | null
  note: string | null
}

export function forecastRowFlows(
  rows: readonly ForecastRowForProjection[],
  window: ForecastWindow,
  /** Open rows dated before today: reported, never projected. */
  pastOpenRows = 0,
): { flows: CashFlow[]; caveats: ForecastCaveat[] } {
  const flows: CashFlow[] = []
  let past = pastOpenRows
  for (const row of rows) {
    if (row.invoice_id || row.supplier_invoice_id) continue
    if (row.expected_date < window.today) {
      past += 1
      continue
    }
    if (row.expected_date > window.end) continue
    const amount = roundOre(Number(row.amount))
    if (!(amount > 0)) continue
    flows.push({
      date: row.expected_date,
      direction: row.direction,
      amount,
      kind: 'forecast',
      source: 'forecast_row',
      estimate: false,
      counterparty: row.external_source,
      reference: row.note ?? row.category,
      ref: { type: 'cash_forecast_row', id: row.id },
      confidence: row.confidence,
    })
  }
  const caveats: ForecastCaveat[] = []
  if (past > 0) {
    caveats.push({
      code: 'FORECAST_ROWS_PAST',
      message_sv: `${past} öppen prognosrad har ett datum före idag och ingår inte. Stryk den, eller ändra datumet om pengarna fortfarande väntas.`,
      message_en: `${past} open forecast row(s) are dated before today and are left out. Cancel them, or move the date if the money is still expected.`,
    })
  }
  return { flows, caveats }
}

/** The open rows inside the window, and how many open rows lie before it. */
export async function loadOpenForecastRows(
  supabase: SupabaseClient,
  companyId: string,
  window: ForecastWindow,
): Promise<{ rows: ForecastRowForProjection[]; pastOpenRows: number }> {
  const [rows, pastRes] = await Promise.all([
    fetchAllRows<ForecastRowForProjection>(({ from, to }) =>
      supabase
        .from('cash_forecast_rows')
        .select('id, expected_date, amount, direction, category, confidence, invoice_id, supplier_invoice_id, external_source, note')
        .eq('company_id', companyId)
        .eq('status', 'open')
        .gte('expected_date', window.today)
        .lte('expected_date', window.end)
        .order('expected_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    supabase
      .from('cash_forecast_rows')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'open')
      // A row linked to an invoice yields to it whatever its date: nothing to cancel.
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .lt('expected_date', window.today),
  ])
  if (pastRes.error) throw Object.assign(new Error(`forecast rows read failed: ${pastRes.error.message}`), { code: pastRes.error.code })
  return { rows, pastOpenRows: pastRes.count ?? 0 }
}
