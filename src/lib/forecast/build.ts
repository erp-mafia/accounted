/**
 * The 13-week liquidity forecast (accounted#136): where the company's bank
 * balance is heading, day by day for 30 days and week by week for 13 ISO
 * weeks, from everything the books and registers already know plus the
 * forecast rows people and systems add.
 *
 * One adapter per source (./adapters), each tagging its flows known, derived
 * or forecast. Each krona counts once:
 *
 *   - an invoice inside a payment order counts at the order's date, the rest
 *     of it at its due date;
 *   - a salary run counts once, as net pay on its payment date; its tax and
 *     avgifter leave through the skattekonto on the AGI's due date;
 *   - a tax charge is met first by the skattekonto saldo and the payments to
 *     it under way;
 *   - a forecast row linked to an invoice yields to the invoice;
 *   - paid invoices are not open, and rows dated before today leave the
 *     projection.
 *
 * Read-only: a forecast never writes, and never touches the books. A source
 * that cannot be read leaves its flows out and says so (complete: false and a
 * SOURCE_UNAVAILABLE caveat) rather than failing the whole forecast.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { forecastEnd } from './calendar'
import { forecastRowFlows, loadOpenForecastRows } from './adapters/forecast-rows'
import { loadPayablesReport, loadReceivablesReport, payableFlows, receivableFlows } from './adapters/invoices'
import { loadOpening } from './adapters/opening'
import { loadPaymentOrders, paymentOrderFlows, skattekontoPaymentsInFlight } from './adapters/payment-orders'
import { loadRecurringSchedules, recurringFlows } from './adapters/recurring'
import { loadSalaryInputs, salaryFlows } from './adapters/salary'
import { loadTaxInputs, taxCharges, taxOutflows, type TaxCharge } from './adapters/tax'
import { projectCashForecast } from './project'
import type { CashFlow, CashForecast, ForecastCaveat, ForecastWindow, OverduePayable, OverdueReceivable } from './types'

const log = createLogger('cash-forecast')

export const DEFAULT_FORECAST_WEEKS = 13
export const MAX_FORECAST_WEEKS = 26

/** The sources a forecast reads, named in SOURCE_UNAVAILABLE. */
export type ForecastSourceName =
  | 'payment_orders'
  | 'receivables'
  | 'payables'
  | 'salary'
  | 'tax'
  | 'recurring_invoices'
  | 'forecast_rows'

const SOURCE_NAMES_SV: Record<ForecastSourceName, string> = {
  payment_orders: 'betalningskön',
  receivables: 'kundfakturorna',
  payables: 'leverantörsfakturorna',
  salary: 'lönerna',
  tax: 'skatterna',
  recurring_invoices: 'de återkommande fakturorna',
  forecast_rows: 'prognosraderna',
}

const SOURCE_NAMES_EN: Record<ForecastSourceName, string> = {
  payment_orders: 'the payment queue',
  receivables: 'customer invoices',
  payables: 'supplier invoices',
  salary: 'salaries',
  tax: 'taxes',
  recurring_invoices: 'recurring invoices',
  forecast_rows: 'forecast rows',
}

function unavailable(source: ForecastSourceName): ForecastCaveat {
  return {
    code: 'SOURCE_UNAVAILABLE',
    message_sv: `${SOURCE_NAMES_SV[source][0].toUpperCase()}${SOURCE_NAMES_SV[source].slice(1)} kunde inte läsas och ingår inte i prognosen. Försök igen.`,
    message_en: `${SOURCE_NAMES_EN[source][0].toUpperCase()}${SOURCE_NAMES_EN[source].slice(1)} could not be read and are not in the forecast. Try again.`,
  }
}

export interface BuildCashForecastOptions {
  /** ISO weeks, the current week first. Default 13, at most 26. */
  weeks?: number
  /** Today in Stockholm; tests pin it. */
  today?: string
}

export async function buildCashForecast(
  supabase: SupabaseClient,
  companyId: string,
  options: BuildCashForecastOptions = {},
): Promise<CashForecast> {
  const weeks = Math.min(Math.max(Math.trunc(options.weeks ?? DEFAULT_FORECAST_WEEKS), 1), MAX_FORECAST_WEEKS)
  const today = options.today ?? todayIsoStockholm()
  const window: ForecastWindow = { today, end: forecastEnd(today, weeks) }
  const caveats: ForecastCaveat[] = []
  let complete = true

  // A failed source becomes a caveat; the forecast goes on without it.
  async function read<T>(source: ForecastSourceName, load: () => Promise<T>): Promise<T | null> {
    try {
      return await load()
    } catch (err) {
      complete = false
      caveats.push(unavailable(source))
      log.warn('forecast source unavailable', { companyId, source, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  // The opening balance is the one thing the forecast cannot do without.
  const opening = await loadOpening(supabase, companyId, today)
  caveats.push(...opening.caveats)

  const [orders, receivables, payables, salaryInputs, taxInputs, recurring, rows] = await Promise.all([
    read('payment_orders', () => loadPaymentOrders(supabase, companyId, today)),
    read('receivables', () => loadReceivablesReport(supabase, companyId)),
    read('payables', () => loadPayablesReport(supabase, companyId)),
    read('salary', () => loadSalaryInputs(supabase, companyId, window)),
    read('tax', () => loadTaxInputs(supabase, companyId, window)),
    read('recurring_invoices', () => loadRecurringSchedules(supabase, companyId)),
    read('forecast_rows', () => loadOpenForecastRows(supabase, companyId, window)),
  ])

  const flows: CashFlow[] = []
  let overdueReceivables: OverdueReceivable[] = []
  let overduePayables: OverduePayable[] = []

  const queue = paymentOrderFlows(orders ?? [], window, opening.balanceTimes)
  flows.push(...queue.flows)
  caveats.push(...queue.caveats)

  if (receivables) {
    const ar = receivableFlows(receivables, window)
    flows.push(...ar.flows)
    caveats.push(...ar.caveats)
    overdueReceivables = ar.overdue
  }
  if (payables) {
    const ap = payableFlows(payables, queue.coverage.supplierInvoices, window)
    flows.push(...ap.flows)
    caveats.push(...ap.caveats)
    overduePayables = ap.overdue
  }

  let salaryBasis = new Map<string, { tax: number; avgifter: number; estimate: boolean }>()
  if (salaryInputs) {
    caveats.push(...salaryInputs.caveats)
    const salary = salaryFlows({ ...salaryInputs, covered: queue.coverage.salaryRuns, window })
    flows.push(...salary.flows)
    caveats.push(...salary.caveats)
    salaryBasis = salary.taxBasis
  }

  if (taxInputs) {
    caveats.push(...taxInputs.caveats)
    const charges = taxCharges({ ...taxInputs, salaryBasis, window })
    const available = roundOre(taxInputs.saldo + skattekontoPaymentsInFlight(queue.skattekontoOrders, taxInputs.snapshotFetchedAtMs))
    // A skattekonto in debt asks for the money now, before any new charge.
    const debt: TaxCharge[] =
      available < 0
        ? [{ due_date: today, amount: -available, kind: 'known', source: 'skattekonto', estimate: false, reference: null, ref: { type: 'skattekonto', id: 'saldo' } }]
        : []
    flows.push(...taxOutflows([...debt, ...charges], Math.max(0, available), window))
  }

  if (recurring) {
    const r = recurringFlows(recurring.schedules, recurring.vatRegistered, window)
    flows.push(...r.flows)
    caveats.push(...r.caveats)
  }

  if (rows) {
    const f = forecastRowFlows(rows.rows, window, rows.pastOpenRows)
    flows.push(...f.flows)
    caveats.push(...f.caveats)
  }

  const projection = projectCashForecast({ window, weeks, opening: opening.opening.amount, flows })
  return {
    currency: 'SEK',
    today,
    horizon: { start: today, end: window.end, weeks },
    opening: opening.opening,
    days: projection.days,
    weeks: projection.weeks,
    lowest: projection.lowest,
    closing: projection.closing,
    flows: projection.flows,
    overdue: {
      receivables: { total: roundOre(overdueReceivables.reduce((s, i) => s + i.amount, 0)), invoices: overdueReceivables },
      payables: { total: roundOre(overduePayables.reduce((s, i) => s + i.amount, 0)), invoices: overduePayables },
    },
    complete,
    caveats,
  }
}
