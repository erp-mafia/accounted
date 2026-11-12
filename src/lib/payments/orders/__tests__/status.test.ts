import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countsAsUsedBankPayment,
  canMovePaymentOrder,
  isBankConfirming,
  isOpenPaymentOrder,
  OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES,
  PAYMENT_ORDER_STATUSES,
  PAYMENT_ORDER_TRANSITIONS,
  type PaymentOrderStatus,
} from '../status'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261010090000_payment_orders.sql'),
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

describe('isBankConfirming', () => {
  it('is an order still awaiting_signature in a signing that finished: the bank has not confirmed it yet', () => {
    expect(isBankConfirming({ status: 'awaiting_signature' }, 'signed')).toBe(true)
    expect(isBankConfirming({ status: 'awaiting_signature' }, 'awaiting_second_signer')).toBe(true)
  })

  it('is not while the BankID still runs, nor for an order that moved on, nor one whose outcome is unknown', () => {
    expect(isBankConfirming({ status: 'awaiting_signature' }, 'awaiting_signature')).toBe(false)
    expect(isBankConfirming({ status: 'awaiting_signature' }, null)).toBe(false)
    expect(isBankConfirming({ status: 'accepted' }, 'signed')).toBe(false)
    expect(isBankConfirming({ status: 'submitted' }, 'signed')).toBe(false)
    expect(isBankConfirming({ status: 'awaiting_signature', outcome_unknown_at: '2026-10-16T12:15:00Z' }, 'signed')).toBe(false)
  })
})

describe('countsAsUsedBankPayment', () => {
  it('counts every order still alive and every signed one, never one that ended unpaid unsigned', () => {
    expect(countsAsUsedBankPayment({ status: 'submitted', signed_at: null })).toBe(true)
    expect(countsAsUsedBankPayment({ status: 'accepted', signed_at: '2026-11-11T08:45:48.164Z' })).toBe(true)
    expect(countsAsUsedBankPayment({ status: 'executed', signed_at: null })).toBe(true)
    expect(countsAsUsedBankPayment({ status: 'rejected', signed_at: '2026-11-11T08:45:48.164Z' })).toBe(true)
    for (const status of ['rejected', 'cancelled', 'failed']) {
      expect(countsAsUsedBankPayment({ status, signed_at: null })).toBe(false)
    }
  })
})
