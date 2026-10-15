import { describe, expect, it, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { findSignedBankPayment, signedBankPaymentDetails } from '../signed-payment'
import { isOpenPaymentOrder, PAYMENT_ORDER_STATUSES, SIGNED_PAYMENT_ORDER_STATUSES } from '../status'

const { supabase, setTable, reset, findCall, findCalls } = createTableMockSupabase()
const client = supabase as unknown as SupabaseClient

beforeEach(() => reset())

describe('findSignedBankPayment (crm#1243)', () => {
  it('asks for the invoice\'s orders that are signed or being signed, inside the company', async () => {
    setTable('payment_orders', { data: [] })

    expect(await findSignedBankPayment(client, 'company-1', 'si-1')).toBeNull()

    expect(findCalls('payment_orders', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['supplier_invoice_id', 'si-1'],
    ])
    expect(findCall('payment_orders', 'in')).toEqual(['status', ['awaiting_signature', 'awaiting_second_signer', 'accepted']])
  })

  it('answers the newest such order', async () => {
    setTable('payment_orders', { data: [{ id: 'order-1', status: 'accepted', requested_execution_date: '2026-10-30' }] })

    const found = await findSignedBankPayment(client, 'company-1', 'si-1')

    expect(found).toEqual({ id: 'order-1', status: 'accepted', requested_execution_date: '2026-10-30' })
    expect(findCall('payment_orders', 'order')).toEqual(['created_at', { ascending: false }])
    expect(signedBankPaymentDetails(found!)).toEqual({
      payment_order_id: 'order-1',
      payment_order_status: 'accepted',
      requested_execution_date: '2026-10-30',
    })
  })

  it('throws when the orders cannot be read: a guard never passes on a failed read', async () => {
    setTable('payment_orders', { data: null, error: { message: 'boom' } })
    await expect(findSignedBankPayment(client, 'company-1', 'si-1')).rejects.toEqual({ message: 'boom' })
  })
})

describe('SIGNED_PAYMENT_ORDER_STATUSES', () => {
  it('is the open states the bank pays without anyone acting again', () => {
    for (const status of PAYMENT_ORDER_STATUSES) {
      const expected = status === 'awaiting_signature' || status === 'awaiting_second_signer' || status === 'accepted'
      expect(SIGNED_PAYMENT_ORDER_STATUSES.has(status)).toBe(expected)
    }
  })

  it('is a subset of the open orders: a failed, rejected or cancelled order never refuses a payment', () => {
    for (const status of SIGNED_PAYMENT_ORDER_STATUSES) {
      expect(isOpenPaymentOrder({ status, supplier_invoice_payment_id: null })).toBe(true)
    }
    for (const status of ['failed', 'rejected', 'cancelled', 'executed', 'draft', 'approved', 'submitted'] as const) {
      expect(SIGNED_PAYMENT_ORDER_STATUSES.has(status)).toBe(false)
    }
  })
})
