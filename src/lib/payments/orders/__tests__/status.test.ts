import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canMovePaymentOrder,
  isOpenPaymentOrder,
  OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES,
  PAYMENT_ORDER_STATUSES,
  PAYMENT_ORDER_TRANSITIONS,
  type PaymentOrderStatus,
} from '../status'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261004010200_payment_orders.sql'),
  'utf8',
)

/** The CASE arms of enforce_payment_order_lifecycle(): OLD.status -> allowed NEW.status list. */
function transitionsFromSql(): Record<string, string[]> {
  const fn = MIGRATION.slice(
    MIGRATION.indexOf('FUNCTION public.enforce_payment_order_lifecycle()'),
    MIGRATION.indexOf('CREATE TRIGGER enforce_payment_order_lifecycle'),
  )
  const out: Record<string, string[]> = {}
  for (const match of fn.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)) {
    out[match[1]!] = [...match[2]!.matchAll(/'(\w+)'/g)].map((m) => m[1]!)
  }
  return out
}

describe('payment order statuses', () => {
  it('lists the same statuses as the table CHECK', () => {
    const check = MIGRATION.match(/status\s+text NOT NULL DEFAULT 'draft' CHECK \(status IN \(([^)]*)\)\)/)
    expect(check).not.toBeNull()
    const sqlStatuses = [...check![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1])
    expect(sqlStatuses).toEqual([...PAYMENT_ORDER_STATUSES])
  })

  it('mirrors the transitions the database trigger allows', () => {
    const sql = transitionsFromSql()
    for (const status of PAYMENT_ORDER_STATUSES) {
      const expected = sql[status] ?? [] // final statuses fall to the ELSE arm: nothing
      expect([...PAYMENT_ORDER_TRANSITIONS[status]].sort(), status).toEqual([...expected].sort())
    }
  })

  it('never lets a final status move', () => {
    for (const from of ['executed', 'rejected', 'cancelled', 'failed'] as PaymentOrderStatus[]) {
      for (const to of PAYMENT_ORDER_STATUSES) {
        expect(canMovePaymentOrder(from, to)).toBe(from === to)
      }
    }
  })

  it('treats an executed order as open until its debit is matched', () => {
    expect(isOpenPaymentOrder({ status: 'executed', supplier_invoice_payment_id: null })).toBe(true)
    expect(isOpenPaymentOrder({ status: 'executed', supplier_invoice_payment_id: 'pay-1' })).toBe(false)
    expect(isOpenPaymentOrder({ status: 'draft' })).toBe(true)
    expect(isOpenPaymentOrder({ status: 'awaiting_second_signer' })).toBe(true)
    expect(isOpenPaymentOrder({ status: 'rejected' })).toBe(false)
    expect(isOpenPaymentOrder({ status: 'cancelled' })).toBe(false)
    expect(isOpenPaymentOrder({ status: 'failed' })).toBe(false)
  })

  it('keeps the open-order read in step with the partial unique index', () => {
    const index = MIGRATION.slice(MIGRATION.indexOf('uq_payment_orders_open_per_supplier_invoice'))
    const open = [...index.slice(0, index.indexOf(';')).matchAll(/'(\w+)'/g)].map((m) => m[1])
    expect([...OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES].sort()).toEqual([...new Set(open)].sort())
    for (const status of OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES) {
      // Every candidate is open for at least one order, so the read never drops an open order.
      expect(isOpenPaymentOrder({ status, supplier_invoice_payment_id: null })).toBe(true)
    }
  })
})
