/**
 * Recurring invoices not created yet: every run of an active schedule inside
 * the horizon becomes an invoice with the schedule's payment terms, so its
 * money is expected on run date + terms. A run that already happened
 * created an invoice, which counts as a receivable (./invoices.ts), and moved
 * next_run_date past it, so no run counts twice.
 *
 * The amount follows the cron's own rule (recurring-schedule-service.ts): the
 * line nets, VAT at the line's rate when the customer's VAT treatment admits
 * it and the customer's default otherwise, none when the company is not
 * VAT-registered. Text rows carry no amount. SEK schedules only (v1).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { computeLineNet, computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { isTextLine } from '@/lib/invoices/recurring-schedule-items'
import { projectRunDates } from '@/lib/invoices/recurring-run-date'
import { getArticleVatRateAdoptionSet, getVatRules } from '@/lib/invoices/vat-rules'
import { roundOre } from '@/lib/money'
import type { CustomerType } from '@/types'
import type { CashFlow, ForecastCaveat, ForecastWindow } from '../types'
import { isPastDue, invoiceDueDate } from '@/lib/dates/iso'

export interface RecurringScheduleRow {
  id: string
  name: string
  day_of_month: number
  interval_months: number
  payment_terms_days: number
  currency: string
  next_run_date: string
  customer: { name: string | null; customer_type: CustomerType; vat_number_validated: boolean | null; country: string | null } | null
  items: Array<{ line_type?: string | null; quantity: number | string; unit_price: number | string; vat_rate: number | string | null }>
}

/** The invoice total one run of the schedule creates. */
export function recurringRunTotal(schedule: RecurringScheduleRow, vatRegistered: boolean): number {
  const customer = schedule.customer
  if (!customer) return 0
  const rules = getVatRules(customer.customer_type, customer.vat_number_validated === true, customer.country)
  const adoptable = getArticleVatRateAdoptionSet(customer.customer_type, customer.vat_number_validated === true, customer.country)
  let total = 0
  for (const item of schedule.items) {
    if (isTextLine(item)) continue
    const net = computeLineNet(Number(item.quantity), Number(item.unit_price))
    const stored = item.vat_rate == null ? null : Number(item.vat_rate)
    const rate = !vatRegistered ? 0 : stored !== null && adoptable.has(stored) ? stored : rules.rate
    total = roundOre(total + net + computeLineVat(net, rate))
  }
  return total
}

export function recurringFlows(
  schedules: readonly RecurringScheduleRow[],
  vatRegistered: boolean,
  window: ForecastWindow,
): { flows: CashFlow[]; caveats: ForecastCaveat[] } {
  const flows: CashFlow[] = []
  let foreign = 0
  for (const s of schedules) {
    if (!isLedgerCurrency(s.currency)) {
      foreign += 1
      continue
    }
    const total = recurringRunTotal(s, vatRegistered)
    if (total <= 0) continue
    // A run whose day passed is sent by the next cron tick: it is due from today.
    const runs = projectRunDates(s.next_run_date, s.day_of_month, Math.max(1, s.interval_months), 24)
    for (const run of runs) {
      const sent = run < window.today ? window.today : run
      const due = invoiceDueDate(sent, s.payment_terms_days)
      if (due > window.end) break
      if (isPastDue(due, window.today)) continue
      flows.push({
        date: due,
        direction: 'in',
        amount: total,
        kind: 'derived',
        source: 'recurring_invoice',
        estimate: false,
        counterparty: s.customer?.name ?? null,
        reference: s.name,
        ref: { type: 'recurring_invoice_schedule', id: s.id },
        confidence: null,
      })
    }
  }
  const caveats: ForecastCaveat[] = []
  if (foreign > 0) {
    caveats.push({
      code: 'FOREIGN_CURRENCY_SCHEDULES_LEFT_OUT',
      message_sv: `${foreign} återkommande faktura i annan valuta än SEK ingår inte i prognosen.`,
      message_en: `${foreign} recurring invoice schedule(s) in a currency other than SEK are not in the forecast.`,
    })
  }
  return { flows, caveats }
}

export async function loadRecurringSchedules(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ schedules: RecurringScheduleRow[]; vatRegistered: boolean }> {
  const [schedulesRes, settingsRes] = await Promise.all([
    supabase
      .from('recurring_invoice_schedules')
      .select(
        'id, name, day_of_month, interval_months, payment_terms_days, currency, next_run_date, customer:customers(name, customer_type, vat_number_validated, country), items:recurring_invoice_schedule_items(line_type, quantity, unit_price, vat_rate)',
      )
      .eq('company_id', companyId)
      .eq('status', 'active'),
    supabase.from('company_settings').select('vat_registered').eq('company_id', companyId).maybeSingle(),
  ])
  for (const res of [schedulesRes, settingsRes]) {
    if (res.error) throw Object.assign(new Error(`recurring schedules read failed: ${res.error.message}`), { code: res.error.code })
  }
  return {
    schedules: (schedulesRes.data ?? []) as unknown as RecurringScheduleRow[],
    // As the cron reads it: only an explicit false is "not registered".
    vatRegistered: (settingsRes.data as { vat_registered?: boolean | null } | null)?.vat_registered !== false,
  }
}
