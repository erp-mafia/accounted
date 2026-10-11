/**
 * What a company has used of its bank payments in a month, counted the way
 * the payment initiation provider bills: every payment that reached the
 * provider (an order with a provider payment id) and every account one left
 * from. The plan includes a number of each per company and month; the rest
 * is charged separately. The counter is read from the orders the ledger
 * already keeps: no second ledger of usage.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** Included per company and month (the provider's allowance, mirrored one to one until the pricing work sets our own). */
export const BANK_PAYMENTS_INCLUDED_PER_MONTH = 30
export const BANK_ACCOUNTS_INCLUDED_PER_MONTH = 2

/** Rows read per month; a company sending more bank payments than this in a month is not a case the counter is built for. */
const USAGE_ROW_CAP = 1000

export interface BankPaymentsUsage {
  /** YYYY-MM in Stockholm time. */
  period: string
  payments_sent: number
  accounts_used: number
  included_payments: number
  included_accounts: number
  extra_payments: number
  extra_accounts: number
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/

export function isUsagePeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD.test(value)
}

export function currentUsagePeriod(): string {
  return todayIsoStockholm().slice(0, 7)
}

function stockholmOffsetMinutes(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Stockholm',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
  return Math.round((wall - at.getTime()) / 60_000)
}

function stockholmMidnightIso(year: number, month: number, day: number): string {
  const guess = Date.UTC(year, month - 1, day)
  return new Date(guess - stockholmOffsetMinutes(new Date(guess)) * 60_000).toISOString()
}

/** The month's bounds as instants: midnight Stockholm on the first, to midnight Stockholm on the next first. */
export function usagePeriodBounds(period: string): { start: string; end: string } {
  const [year, month] = period.split('-').map(Number)
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  return { start: stockholmMidnightIso(year, month, 1), end: stockholmMidnightIso(next.year, next.month, 1) }
}

export async function getBankPaymentsUsage(supabase: SupabaseClient, companyId: string, period?: string): Promise<BankPaymentsUsage> {
  const month = period && isUsagePeriod(period) ? period : currentUsagePeriod()
  const { start, end } = usagePeriodBounds(month)
  const { data, error } = await supabase
    .from('payment_orders')
    .select('cash_account_id')
    .eq('company_id', companyId)
    .not('provider_payment_id', 'is', null)
    .gte('created_at', start)
    .lt('created_at', end)
    .limit(USAGE_ROW_CAP)
  if (error) throw error
  const rows = (data ?? []) as Array<{ cash_account_id: string | null }>
  const paymentsSent = rows.length
  const accountsUsed = new Set(rows.map((r) => r.cash_account_id).filter((id): id is string => !!id)).size
  return {
    period: month,
    payments_sent: paymentsSent,
    accounts_used: accountsUsed,
    included_payments: BANK_PAYMENTS_INCLUDED_PER_MONTH,
    included_accounts: BANK_ACCOUNTS_INCLUDED_PER_MONTH,
    extra_payments: Math.max(0, paymentsSent - BANK_PAYMENTS_INCLUDED_PER_MONTH),
    extra_accounts: Math.max(0, accountsUsed - BANK_ACCOUNTS_INCLUDED_PER_MONTH),
  }
}
