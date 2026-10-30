/**
 * The bank payment queue (payment_orders): each payment counts once, at the
 * order's date, and what it pays drops out of its own source:
 *
 *   - supplier_invoice: the invoice counts only for what no order covers
 *     (./invoices.ts payableFlows);
 *   - salary: the run's net pay counts only for what no order covers
 *     (./salary.ts);
 *   - skattekonto: the payment fills the skattekonto, so it covers the tax
 *     charges (./tax.ts), the way Hem's Betala row counts it
 *     (skattekontoPaymentsCovering: a draft nobody approved pays nothing).
 *
 * An order still on its way counts on its requested date, or today when that
 * date has passed. An executed order has left the bank: it is in the opening
 * balance when the bank reported that balance after the execution, and
 * otherwise counts today. Either way it covers what it paid until the
 * settlement records the payment.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { addDaysIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import {
  SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES,
  skattekontoPaymentsCovering,
} from '@/lib/payments/orders/skattekonto-underway'
import type { CashFlow, ForecastCaveat, ForecastWindow } from '../types'

/** From draft to accepted at the bank: the payment has not left yet. */
const LIVE_STATUSES = ['draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'] as const

export interface PaymentOrderRow {
  id: string
  purpose: 'supplier_invoice' | 'skattekonto' | 'salary' | string
  status: string
  amount: number | string
  currency: string
  requested_execution_date: string
  supplier_invoice_id: string | null
  salary_run_id: string | null
  cash_account_id: string | null
  payee_name: string | null
  reference: string | null
  executed_at: string | null
  matched_at: string | null
}

export interface PaymentOrderCoverage {
  /** supplier_invoice_id -> what orders pay of it. */
  supplierInvoices: Map<string, number>
  /** salary_run_id -> what orders pay of its net. */
  salaryRuns: Map<string, number>
}

export interface PaymentOrdersResult {
  flows: CashFlow[]
  coverage: PaymentOrderCoverage
  /** The skattekonto payments to count against its charges, for ./tax.ts. */
  skattekontoOrders: PaymentOrderRow[]
  caveats: ForecastCaveat[]
}

function add(map: Map<string, number>, key: string | null, amount: number) {
  if (!key) return
  map.set(key, roundOre((map.get(key) ?? 0) + amount))
}

export function paymentOrderFlows(
  orders: readonly PaymentOrderRow[],
  window: ForecastWindow,
  /** cash_account_id -> when the bank reported the balance in the opening. */
  balanceTimes: ReadonlyMap<string, string>,
): PaymentOrdersResult {
  const flows: CashFlow[] = []
  const coverage: PaymentOrderCoverage = { supplierInvoices: new Map(), salaryRuns: new Map() }
  const live = new Set<string>(LIVE_STATUSES)
  const skattekontoUnderway = new Set<string>(SKATTEKONTO_PAYMENT_UNDERWAY_STATUSES)
  let foreign = 0

  for (const order of orders) {
    const executed = order.status === 'executed'
    if (!executed && !live.has(order.status)) continue
    // A settled supplier payment is recorded on the invoice: nothing left to cover.
    if (executed && order.purpose === 'supplier_invoice' && order.matched_at) continue
    if (!isLedgerCurrency(order.currency)) {
      foreign += 1
      continue
    }
    const amount = roundOre(Number(order.amount))
    if (!(amount > 0)) continue
    // A skattekonto draft nobody approved pays nothing (skattekonto-underway.ts).
    if (order.purpose === 'skattekonto' && !executed && !skattekontoUnderway.has(order.status)) continue

    if (order.purpose === 'supplier_invoice') add(coverage.supplierInvoices, order.supplier_invoice_id, amount)
    if (order.purpose === 'salary') add(coverage.salaryRuns, order.salary_run_id, amount)

    let date: string | null
    if (executed) {
      const reported = order.cash_account_id ? balanceTimes.get(order.cash_account_id) : undefined
      if (reported) {
        date = order.executed_at && Date.parse(reported) >= Date.parse(order.executed_at) ? null : window.today
      } else {
        // No bank balance for the account: the opening is the booked one. A
        // salary payment's bank leg is in the run's voucher; a supplier or
        // skattekonto payment is booked only when its bank row is.
        date = order.purpose === 'salary' ? null : window.today
      }
    } else {
      date = order.requested_execution_date < window.today ? window.today : order.requested_execution_date
    }
    if (date === null || date > window.end) continue
    flows.push({
      date,
      direction: 'out',
      amount,
      kind: 'known',
      source: 'payment_order',
      estimate: false,
      counterparty: order.payee_name,
      reference: order.reference,
      ref: { type: 'payment_order', id: order.id },
      confidence: null,
    })
  }

  const caveats: ForecastCaveat[] = []
  if (foreign > 0) {
    caveats.push({
      code: 'FOREIGN_CURRENCY_PAYMENTS_LEFT_OUT',
      message_sv: `${foreign} betalning i annan valuta än SEK ingår inte i prognosen.`,
      message_en: `${foreign} payment(s) in a currency other than SEK are not in the forecast.`,
    })
  }
  return { flows, coverage, skattekontoOrders: orders.filter((o) => o.purpose === 'skattekonto'), caveats }
}

/** What the skattekonto payments add to the saldo the charges are drawn from (see skattekontoPaymentsCovering). */
export function skattekontoPaymentsInFlight(orders: readonly PaymentOrderRow[], snapshotFetchedAtMs: number | null): number {
  return skattekontoPaymentsCovering(
    orders.filter((o) => isLedgerCurrency(o.currency)),
    snapshotFetchedAtMs,
  )
}

/** How far back an executed payment can still be missing from the opening balance or its settlement. */
const EXECUTED_LOOKBACK_DAYS = 14

export async function loadPaymentOrders(supabase: SupabaseClient, companyId: string, today: string): Promise<PaymentOrderRow[]> {
  const executedSince = `${addDaysIso(today, -EXECUTED_LOOKBACK_DAYS)}T00:00:00Z`
  const [liveRes, executedRes] = await Promise.all([
    supabase
      .from('payment_orders')
      .select(
        'id, purpose, status, amount, currency, requested_execution_date, supplier_invoice_id, salary_run_id, cash_account_id, payee_name, reference, executed_at, matched_at',
      )
      .eq('company_id', companyId)
      .in('status', [...LIVE_STATUSES])
      .order('requested_execution_date', { ascending: true })
      .limit(1000),
    // An executed payment older than this is in every balance and settled.
    supabase
      .from('payment_orders')
      .select(
        'id, purpose, status, amount, currency, requested_execution_date, supplier_invoice_id, salary_run_id, cash_account_id, payee_name, reference, executed_at, matched_at',
      )
      .eq('company_id', companyId)
      .eq('status', 'executed')
      .gte('executed_at', executedSince)
      .order('requested_execution_date', { ascending: true })
      .limit(1000),
  ])
  for (const res of [liveRes, executedRes]) {
    if (res.error) throw Object.assign(new Error(`payment orders read failed: ${res.error.message}`), { code: res.error.code })
  }
  return [...(liveRes.data ?? []), ...(executedRes.data ?? [])] as PaymentOrderRow[]
}
