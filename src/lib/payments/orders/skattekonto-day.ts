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
