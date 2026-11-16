import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { isOpenPaymentOrder, PAYMENT_ORDER_STATUSES, paymentOrderWaitsFor, UNSIGNED_PAYMENT_ORDER_STATUSES } from '../status'
import { readUnsignedPayments, summarizeUnsignedPayments } from '../unsigned-payments'

const COMPANY = 'company-1'

const order = (status: string, amount: number | string, day: string, currency = 'SEK') => ({
  status,
  amount,
  currency,
  requested_execution_date: day,
})

describe('paymentOrderWaitsFor: what an order waits for from a person (crm#1925)', () => {
  it('a prepared order waits for its approval, an approved one for its BankID signature', () => {
    expect(paymentOrderWaitsFor({ status: 'draft' })).toBe('approval')
    expect(paymentOrderWaitsFor({ status: 'approved' })).toBe('signature')
  })

  it('nothing once the order has gone to the bank, and nothing when it is closed', () => {
    for (const status of ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed', 'rejected', 'cancelled', 'failed']) {
      expect(paymentOrderWaitsFor({ status })).toBeNull()
    }
  })

  it('the status list a read filters on is the same rule, for every status the table allows', () => {
    const listed: readonly string[] = UNSIGNED_PAYMENT_ORDER_STATUSES
    for (const status of PAYMENT_ORDER_STATUSES) {
      expect(paymentOrderWaitsFor({ status }) !== null).toBe(listed.includes(status))
    }
  })

  it('an order that waits is open all the same: it covers its invoice, which is why "open" never said that somebody is asked', () => {
    for (const status of UNSIGNED_PAYMENT_ORDER_STATUSES) expect(isOpenPaymentOrder({ status })).toBe(true)
  })
})

describe('summarizeUnsignedPayments: the facts of the Att göra row', () => {
  it('says nothing when no payment waits', () => {
    expect(summarizeUnsignedPayments([])).toBeNull()
    expect(summarizeUnsignedPayments([order('accepted', 1250, '2026-11-20'), order('cancelled', 400, '2026-11-18')])).toBeNull()
  })

  it('counts the ones to approve and the ones to sign together, with the earliest payment day and their sum', () => {
    // Two prepared by an agent, one a person approved and left unsigned.
    expect(
      summarizeUnsignedPayments([
        order('draft', '12500.00', '2026-11-27'),
        order('draft', '3999.50', '2026-11-20'),
        order('approved', 800.25, '2026-11-24'),
      ]),
    ).toEqual({ count: 3, to_approve: 2, next_date: '2026-11-20', amount: 17299.75, currency: 'SEK' })
  })

  it('has nothing to approve when every payment is approved already', () => {
    expect(summarizeUnsignedPayments([order('approved', 100, '2026-11-20'), order('approved', 200, '2026-11-19')])).toEqual({
      count: 2,
      to_approve: 0,
      next_date: '2026-11-19',
      amount: 300,
      currency: 'SEK',
    })
  })

  it('sums to the öre: 0.10 + 0.20 is 0.30', () => {
    expect(summarizeUnsignedPayments([order('draft', 0.1, '2026-11-20'), order('draft', 0.2, '2026-11-20')])?.amount).toBe(0.3)
  })

  it('gives no sum across currencies, and still counts every payment', () => {
    expect(summarizeUnsignedPayments([order('draft', 100, '2026-11-20'), order('approved', 50, '2026-11-21', 'EUR')])).toEqual({
      count: 2,
      to_approve: 1,
      next_date: '2026-11-20',
      amount: null,
      currency: null,
    })
  })

  it('leaves out an order of any other status that a caller passes along', () => {
    expect(summarizeUnsignedPayments([order('draft', 100, '2026-11-25'), order('submitted', 900, '2026-11-01')])).toEqual({
      count: 1,
      to_approve: 1,
      next_date: '2026-11-25',
      amount: 100,
      currency: 'SEK',
    })
  })
})

describe('readUnsignedPayments', () => {
  it('reads the company\'s draft and approved orders of every purpose', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: [order('draft', 1500, '2026-11-20'), order('approved', 500, '2026-11-18')] } })

    expect(await readUnsignedPayments(db.supabase as unknown as SupabaseClient, COMPANY)).toEqual({
      count: 2,
      to_approve: 1,
      next_date: '2026-11-18',
      amount: 2000,
      currency: 'SEK',
    })
    expect(db.findCall('payment_orders', 'in')).toEqual(['status', ['draft', 'approved']])
    // The company and nothing else: no purpose filter, a skattekonto or salary payment nobody signed waits too.
    expect(db.findCalls('payment_orders', 'eq')).toEqual([['company_id', COMPANY]])
  })

  it('answers null when nothing waits', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: [] } })
    expect(await readUnsignedPayments(db.supabase as unknown as SupabaseClient, COMPANY)).toBeNull()
  })

  it('throws on a failed read, for the worklist to soft-fail', async () => {
    const db = createTableMockSupabase({ payment_orders: { data: null, error: { message: 'boom', code: '500' } } })
    await expect(readUnsignedPayments(db.supabase as unknown as SupabaseClient, COMPANY)).rejects.toMatchObject({ message: 'boom' })
  })
})
