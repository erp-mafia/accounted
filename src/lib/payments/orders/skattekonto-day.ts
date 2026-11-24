/**
 * One open skattekonto payment per company and execution day
 * (uq_payment_orders_open_skattekonto_per_date, crm#1485). Preparing a
 * payment adds to the day's open order (create_skattekonto_payment_order);
 * this module is the other half: a draft whose day has passed moves to the
 * next banking day when it is approved or signed, and that day may already
 * hold an open order. The move is refused before anything is written, with
 * SKATTEKONTO_PAYMENT_DAY_TAKEN (409), never left to the index as a 500.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationOutcome } from '@/lib/operations/types'
import { roundOre } from '@/lib/money'
import { executionDateFor, previousBankDayIso } from '@/lib/payments/bank-days'
import type { PaymentOrderRow } from './types'

/**
 * An open skattekonto order: from the draft until the bank accepted it. The
 * database allows one per company and execution day (uq_payment_orders_open_skattekonto_per_date).
 */
export const OPEN_SKATTEKONTO_ORDER_STATUSES = [
  'draft',
  'approved',
  'submitted',
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
] as const

/**
 * The day a payment towards a due date goes out unless the person picks
 * another: the banking day before Skatteverket draws, so the money is on the
 * skattekonto by the due date, and never before the earliest day the bank takes.
 */
export function skattekontoPaymentDayFor(dueDate: string, today: string): string {
  return executionDateFor(previousBankDayIso(dueDate), today)
}

/** A day's open skattekonto order, as the one-per-day rule reads it. */
export interface OpenSkattekontoOrder {
  id: string
  status: string
  amount: number | string
  batch_id: string | null
}

/** The open skattekonto order on a day (the index allows one), or null. */
export async function readOpenSkattekontoOrderOnDay(
  client: SupabaseClient,
  companyId: string,
  day: string,
): Promise<OpenSkattekontoOrder | null> {
  const { data, error } = await client
    .from('payment_orders')
    .select('id, status, amount, batch_id')
    .eq('company_id', companyId)
    .eq('purpose', 'skattekonto')
    .eq('requested_execution_date', day)
    .in('status', [...OPEN_SKATTEKONTO_ORDER_STATUSES])
  if (error) throw error
  return ((data ?? []) as OpenSkattekontoOrder[])[0] ?? null
}

/**
 * Whether a day's open order is in payment: signed, or at the bank. A new
 * payment on that day is then refused (SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT),
 * and a declaration paid on it offers no second payment. An order nobody
 * signed yet (a draft, or approved and not claimed for signing) takes a new
 * payment as an addition instead.
 */
export function isSkattekontoDayInPayment(order: Pick<OpenSkattekontoOrder, 'status' | 'batch_id'>): boolean {
  return (order.status !== 'draft' && order.status !== 'approved') || !!order.batch_id
}

/** A bank payment to the skattekonto made towards a due date (readSkattekontoPaymentTowards). */
export interface SkattekontoPaymentTowards extends OpenSkattekontoOrder {
  requested_execution_date: string
}

/**
 * The bank payment to the skattekonto made towards a due date: on the day it
 * goes out by default (the banking day before the draw, or the day the bank
 * takes now when that has passed), signed, at the bank or executed. An order
 * nobody signed yet pays nothing and is left out. The orders do not record
 * which declaration they pay: this is the payment of the due date's day,
 * whatever it covers; null when there is none.
 */
export async function readSkattekontoPaymentTowards(
  client: SupabaseClient,
  companyId: string,
  dueDate: string,
  today: string,
): Promise<SkattekontoPaymentTowards | null> {
  const planned = previousBankDayIso(dueDate)
  const days = [...new Set([planned, skattekontoPaymentDayFor(dueDate, today)])]
  const { data, error } = await client
    .from('payment_orders')
    .select('id, status, amount, batch_id, requested_execution_date')
    .eq('company_id', companyId)
    .eq('purpose', 'skattekonto')
    .in('requested_execution_date', days)
    .in('status', [...OPEN_SKATTEKONTO_ORDER_STATUSES, 'executed'])
  if (error) throw error
  const paying = ((data ?? []) as SkattekontoPaymentTowards[]).filter(
    (order) => order.status === 'executed' || isSkattekontoDayInPayment(order),
  )
  // The planned day first: the payment made before that day passed.
  return paying.find((order) => order.requested_execution_date === planned) ?? paying[0] ?? null
}

/**
 * Whether a bank payment to the skattekonto pays a declaration: its amount is
 * the declaration's, to the öre, as the dialog's possible_duplicate reads a
 * payment of the same amount (prepare-skattekonto.ts). The orders do not
 * record which declaration they pay, and a larger one on the same day may be
 * another declaration's (the momsdeklaration is often due the same 12th as
 * the AGI), so a larger amount is never read as paying this one.
 */
export function skattekontoPaymentPaysDeclaration(paymentAmount: number, declared: number): boolean {
  const owed = roundOre(declared)
  return owed > 0 && roundOre(paymentAmount) === owed
}

export const SKATTEKONTO_DAY_TAKEN = 'SKATTEKONTO_PAYMENT_DAY_TAKEN'

type Refusal = Extract<OperationOutcome<never>, { ok: false }>

/** The unique index answered: another open skattekonto order got the day first. */
export function isDayTakenError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505'
}

export function dayTakenRefusal(orderId: string, day: string, holder: { id: string; status: string } | null): Refusal {
  return {
    ok: false,
    code: SKATTEKONTO_DAY_TAKEN,
    details: {
      payment_order_id: orderId,
      requested_execution_date: day,
      ...(holder ? { existing_payment_order_id: holder.id, existing_status: holder.status } : {}),
    },
  }
}

/**
 * The first skattekonto order in `moves` whose new day is held by another
 * open skattekonto order (or by an earlier order of the same selection), as
 * a refusal; null when every move is free. Orders of other purposes are not
 * read: the index covers the skattekonto alone.
 */
export async function skattekontoDayRefusal(
  client: SupabaseClient,
  companyId: string,
  moves: Array<{ order: Pick<PaymentOrderRow, 'id' | 'purpose'>; to: string }>,
): Promise<Refusal | null> {
  const skattekonto = moves.filter((m) => m.order.purpose === 'skattekonto')
  if (skattekonto.length === 0) return null
  const days = [...new Set(skattekonto.map((m) => m.to))]
  const { data, error } = await client
    .from('payment_orders')
    .select('id, status, requested_execution_date')
    .eq('company_id', companyId)
    .eq('purpose', 'skattekonto')
    .in('requested_execution_date', days)
    .in('status', [...OPEN_SKATTEKONTO_ORDER_STATUSES])
  if (error) throw error
  const open = (data ?? []) as Array<{ id: string; status: string; requested_execution_date: string }>
  const moving = new Set(skattekonto.map((m) => m.order.id))
  const claimed = new Map<string, string>()
  for (const { order, to } of skattekonto) {
    const holder = open.find((o) => o.requested_execution_date === to && !moving.has(o.id))
    if (holder) return dayTakenRefusal(order.id, to, holder)
    const earlier = claimed.get(to)
    if (earlier) return dayTakenRefusal(order.id, to, { id: earlier, status: 'draft' })
    claimed.set(to, order.id)
  }
  return null
}
