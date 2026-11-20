/**
 * Bank payments that wait for a person: prepared and not approved, or
 * approved and not signed (paymentOrderWaitsFor in status.ts). Nothing has
 * gone to the bank, and nothing is paid until someone signs with BankID.
 *
 * A payment prepared by an agent or through the API stops here until a person
 * approves and signs it, and so does every payment whose BankID ended
 * unsigned (the orders go back to approved, crm#1470). The order already
 * covers its invoice, so the invoice has left "Betala N leverantörsfakturor",
 * and nothing asked for the signature: the payment was found only by opening
 * Betalningar (crm#1925). The Att göra row "Signera N betalningar" is derived
 * here on every read, nothing written.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaymentsToSignDue } from '@/lib/worklist/types'
import { sumOre } from '@/lib/money'
import { paymentOrderWaitsFor, UNSIGNED_PAYMENT_ORDER_STATUSES } from './status'

/**
 * How many unsigned orders one read considers, earliest payment day first.
 * A company with more than this many payments waiting for a signature has a
 * row that says so already; the count clamps there.
 */
const SCAN_CAP = 1000

export interface UnsignedOrderRow {
  status: string
  amount: number | string
  currency: string
  requested_execution_date: string
}

/**
 * The row's facts from the orders that wait: how many, how many of them
 * nobody has approved, the earliest day the bank is asked to pay one, and
 * their sum when they share a currency (a sum across currencies says
 * nothing). Null when none waits. Rows of any other status are left out, so
 * a caller may pass more than it should.
 */
export function summarizeUnsignedPayments(rows: readonly UnsignedOrderRow[]): PaymentsToSignDue | null {
  const waiting = rows.flatMap((row) => {
    const waitsFor = paymentOrderWaitsFor(row)
    return waitsFor ? [{ row, waitsFor }] : []
  })
  if (waiting.length === 0) return null
  const days = waiting.map(({ row }) => row.requested_execution_date).sort()
  const oneCurrency = new Set(waiting.map(({ row }) => row.currency)).size === 1
  return {
    count: waiting.length,
    to_approve: waiting.filter(({ waitsFor }) => waitsFor === 'approval').length,
    next_date: days[0],
    amount: oneCurrency ? sumOre(waiting.map(({ row }) => Number(row.amount))) : null,
    currency: oneCurrency ? waiting[0].row.currency : null,
  }
}

/**
 * The company's bank payments that wait for a person's approval or BankID
 * signature (lib/worklist payments_to_sign): every purpose (a supplier
 * invoice, the skattekonto, a salary), the same orders the Betalningar page
 * lists under Att godkänna and Att signera. Null when there are none.
 *
 * Throws on a failed read; the worklist soft-fails it.
 */
export async function readUnsignedPayments(supabase: SupabaseClient, companyId: string): Promise<PaymentsToSignDue | null> {
  const { data, error } = await supabase
    .from('payment_orders')
    .select('id, status, amount, currency, requested_execution_date')
    .eq('company_id', companyId)
    .in('status', [...UNSIGNED_PAYMENT_ORDER_STATUSES])
    .order('requested_execution_date', { ascending: true })
    .limit(SCAN_CAP)
  if (error) throw error
  return summarizeUnsignedPayments((data ?? []) as UnsignedOrderRow[])
}
