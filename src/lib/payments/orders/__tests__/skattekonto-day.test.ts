import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isSkattekontoDayInPayment,
  isSkattekontoPaymentSigned,
  readSkattekontoPaymentsTowards,
  skattekontoPaymentDayFor,
  skattekontoPaymentPaysDeclaration,
} from '../skattekonto-day'
import { PAYMENT_ORDER_STATUSES } from '../status'

describe('skattekontoPaymentDayFor', () => {
  it('is the banking day before the due date', () => {
    // Monday 14 December 2026 (the 12th is a Saturday): the Friday before.
    expect(skattekontoPaymentDayFor('2026-12-14', '2026-11-24')).toBe('2026-12-11')
  })

  it('is never before the earliest day the bank takes', () => {
    // Due tomorrow: the bank takes nothing earlier than tomorrow.
    expect(skattekontoPaymentDayFor('2026-11-26', '2026-11-25')).toBe('2026-11-26')
  })
})

describe('isSkattekontoDayInPayment', () => {
  it('is false for an order nobody signed yet', () => {
    expect(isSkattekontoDayInPayment({ status: 'draft', batch_id: null })).toBe(false)
    expect(isSkattekontoDayInPayment({ status: 'approved', batch_id: null })).toBe(false)
  })

  it('is true once the order is claimed for signing, signed or at the bank', () => {
    expect(isSkattekontoDayInPayment({ status: 'approved', batch_id: 'batch-1' })).toBe(true)
    for (const status of ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted']) {
      expect(isSkattekontoDayInPayment({ status, batch_id: null })).toBe(true)
    }
  })
})

describe('readSkattekontoPaymentsTowards', () => {
  const order = (status: string, day: string, batch: string | null = 'batch-1') => ({
    id: `order-${status}-${day}`,
    status,
    amount: '100.00',
    batch_id: batch,
    requested_execution_date: day,
  })

  it('reads from the banking day before the due date through the due date, earliest first', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [order('accepted', '2026-12-14'), order('draft', '2026-12-11', null), order('executed', '2026-12-11')] })

    const found = await readSkattekontoPaymentsTowards(supabase as unknown as SupabaseClient, 'company-1', '2026-12-14')

    expect(found.map((o) => o.id)).toEqual(['order-executed-2026-12-11', 'order-accepted-2026-12-14'])
    expect(findCalls('payment_orders', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['purpose', 'skattekonto'],
    ])
    expect(findCalls('payment_orders', 'gte')).toEqual([['requested_execution_date', '2026-12-11']])
    expect(findCalls('payment_orders', 'lte')).toEqual([['requested_execution_date', '2026-12-14']])
  })

  it('answers nothing for a draft or an approved order nobody claimed for signing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [order('draft', '2026-12-11', null), order('approved', '2026-12-11', null)] })

    expect(await readSkattekontoPaymentsTowards(supabase as unknown as SupabaseClient, 'company-1', '2026-12-14')).toEqual([])
  })

  it('keeps an order that reached the bank unsigned: it is shown, though it pays nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [order('submitted', '2026-12-11')] })

    const found = await readSkattekontoPaymentsTowards(supabase as unknown as SupabaseClient, 'company-1', '2026-12-14')

    expect(found.map((o) => o.status)).toEqual(['submitted'])
    expect(isSkattekontoPaymentSigned(found[0])).toBe(false)
  })
})

describe('isSkattekontoPaymentSigned', () => {
  const SIGNED_OR_EXECUTED = ['awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']

  it('is true for an order signed, or being signed, at the bank and for an executed one', () => {
    for (const status of SIGNED_OR_EXECUTED) expect(isSkattekontoPaymentSigned({ status })).toBe(true)
  })

  it('is false for every other status: unsigned at the bank (submitted) never executes', () => {
    const others = PAYMENT_ORDER_STATUSES.filter((status) => !SIGNED_OR_EXECUTED.includes(status))
    expect(others).toEqual(['draft', 'approved', 'submitted', 'rejected', 'cancelled', 'failed'])
    for (const status of others) expect(isSkattekontoPaymentSigned({ status })).toBe(false)
  })
})

describe('skattekontoPaymentPaysDeclaration', () => {
  const signed = (amount: number | string) => ({ status: 'accepted', amount })

  it('is true for a signed payment of exactly the declared amount, to the öre', () => {
    expect(skattekontoPaymentPaysDeclaration(signed(24568), 12000 + 12568)).toBe(true)
    expect(skattekontoPaymentPaysDeclaration(signed('1234.56'), 1234.56)).toBe(true)
  })

  it('is true for every signed or executed status', () => {
    for (const status of ['awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']) {
      expect(skattekontoPaymentPaysDeclaration({ status, amount: '24568.00' }, 24568)).toBe(true)
    }
  })

  it('is false for the exact amount at the bank unsigned, or claimed for signing and not signed yet', () => {
    expect(skattekontoPaymentPaysDeclaration({ status: 'submitted', amount: '24568.00' }, 24568)).toBe(false)
    expect(skattekontoPaymentPaysDeclaration({ status: 'approved', amount: '24568.00' }, 24568)).toBe(false)
  })

  it('is false for a larger payment: it may be another declaration due the same day', () => {
    expect(skattekontoPaymentPaysDeclaration(signed(60000), 24568)).toBe(false)
  })

  it('is false for a smaller payment and for a declaration asking for nothing', () => {
    expect(skattekontoPaymentPaysDeclaration(signed(24567.99), 24568)).toBe(false)
    expect(skattekontoPaymentPaysDeclaration(signed(0), 0)).toBe(false)
  })
})
