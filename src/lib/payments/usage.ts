/**
 * What a company has used of its bank payments in a month, counted the way
 * the payment initiation provider bills: every payment that reached the
 * provider (an order with a provider payment id) and every account one left
 * from, in the month a signing sent it, never the month it was drafted. The
 * counter is read from the orders the ledger already keeps: no second ledger
 * of usage.
 *
 * Payments are capped (founder decision 2026-10-14, while the provider
 * prices per payment and our own pricing is not set): a company may send
 * BANK_PAYMENTS_INCLUDED_PER_MONTH a month, or the number a founder set for
 * it in company_bank_payment_allowances, plus BANK_PAYMENTS_PER_PACK for every
 * pack its owner bought on the subscription (issue #132), and a signing that
 * would pass it is refused (lib/payments/allowance.ts). Accounts are counted
 * for display only.
 * Payment files (betalfil) never reach the provider and are not counted.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm } from '@/lib/dates/iso'

/** Payments per company and Stockholm calendar month, unless company_bank_payment_allowances says otherwise. A hard cap. */
export const BANK_PAYMENTS_INCLUDED_PER_MONTH = 10
/** Accounts per company and month the plan includes: display only, never enforced. */
export const BANK_ACCOUNTS_INCLUDED_PER_MONTH = 2

/** Rows read per month; a company sending more bank payments than this in a month is not a case the counter (or the cap) is built for. */
const USAGE_ROW_CAP = 1000

export interface BankPaymentsUsage {
  /** YYYY-MM in Stockholm time. */
  period: string
  payments_sent: number
  accounts_used: number
  /** The cap: the company's allowance, or the default. */
  included_payments: number
  included_accounts: number
  /** Payments the company may still send this month (0 when the cap is reached). */
  remaining_payments: number
  /** Beyond the cap: two signings racing each other, or an allowance lowered mid-month. */
  extra_payments: number
  extra_accounts: number
}

/** The month's orders that reached the provider, and the company's cap: what the counter and the cap are read from. */
export interface BankPaymentsMonth {
  period: string
  sent: Array<{ id: string; cash_account_id: string | null }>
  included_payments: number
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

/**
 * The table not existing yet: hosted deploys a merge before main's pipeline
 * applies its migration, and a self-host may run the code a moment before
 * its migrations. Read as "no allowance set" so payments keep the default cap
 * in that window instead of every signing failing.
 */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205'])

/**
 * Bank payments a month one bought pack adds (issue #132). The one place the
 * pack size lives: the cap, the purchase dialog and the billing page all read
 * it from here. The pack's price is Stripe's (STRIPE_PRICE_PAYMENTS_PACK).
 */
export const BANK_PAYMENTS_PER_PACK = 100

/** What a company may send a month, and what it is made of. */
export interface BankPaymentsAllowance {
  /** The base: the number a founder set for the company, else the default. */
  base: number
  /** Packs on the company's Stripe subscription (the webhook keeps purchased_packs). */
  packs: number
  /** The cap: base + packs x BANK_PAYMENTS_PER_PACK. */
  included: number
}

/** The allowance a company_bank_payment_allowances row (or its absence) gives. */
export function allowanceOf(row: { monthly_payments?: number | null; purchased_packs?: number | null } | null): BankPaymentsAllowance {
  const base = typeof row?.monthly_payments === 'number' ? row.monthly_payments : BANK_PAYMENTS_INCLUDED_PER_MONTH
  const packs = typeof row?.purchased_packs === 'number' && row.purchased_packs > 0 ? row.purchased_packs : 0
  return { base, packs, included: base + packs * BANK_PAYMENTS_PER_PACK }
}

/**
 * The company's allowance row, read whole: `*` rather than named columns so
 * a deploy that runs a moment before its migration (purchased_packs not there
 * yet) reads the row it has instead of failing every signing.
 */
export async function readBankPaymentsAllowance(supabase: SupabaseClient, companyId: string): Promise<BankPaymentsAllowance> {
  const { data, error } = await supabase.from('company_bank_payment_allowances').select('*').eq('company_id', companyId).maybeSingle()
  if (error && MISSING_TABLE_CODES.has((error as { code?: string }).code ?? '')) return allowanceOf(null)
  if (error) throw error
  return allowanceOf(data as { monthly_payments?: number | null; purchased_packs?: number | null } | null)
}

/** The payments a company may send a month: the base (a founder's override, else the default) plus the packs it bought. */
export async function includedBankPayments(supabase: SupabaseClient, companyId: string): Promise<number> {
  return (await readBankPaymentsAllowance(supabase, companyId)).included
}

/**
 * Counted by submitted_at: the signing's claim, written right before the same
 * request asks the provider to create the payment, and the moment the cap is
 * checked. A new claim, after the bank cancelled the earlier payment, sets it
 * again.
 */
export async function readBankPaymentsMonth(supabase: SupabaseClient, companyId: string, period?: string): Promise<BankPaymentsMonth> {
  const month = period && isUsagePeriod(period) ? period : currentUsagePeriod()
  const { start, end } = usagePeriodBounds(month)
  const { data, error } = await supabase
    .from('payment_orders')
    .select('id, cash_account_id')
    .eq('company_id', companyId)
    .not('provider_payment_id', 'is', null)
    .gte('submitted_at', start)
    .lt('submitted_at', end)
    .limit(USAGE_ROW_CAP)
  if (error) throw error
  const included = await includedBankPayments(supabase, companyId)
  return { period: month, sent: (data ?? []) as BankPaymentsMonth['sent'], included_payments: included }
}

export async function getBankPaymentsUsage(supabase: SupabaseClient, companyId: string, period?: string): Promise<BankPaymentsUsage> {
  const month = await readBankPaymentsMonth(supabase, companyId, period)
  const paymentsSent = month.sent.length
  const accountsUsed = new Set(month.sent.map((r) => r.cash_account_id).filter((id): id is string => !!id)).size
  const included = month.included_payments
  return {
    period: month.period,
    payments_sent: paymentsSent,
    accounts_used: accountsUsed,
    included_payments: included,
    included_accounts: BANK_ACCOUNTS_INCLUDED_PER_MONTH,
    remaining_payments: Math.max(0, included - paymentsSent),
    extra_payments: Math.max(0, paymentsSent - included),
    extra_accounts: Math.max(0, accountsUsed - BANK_ACCOUNTS_INCLUDED_PER_MONTH),
  }
}
