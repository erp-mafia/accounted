import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isSkattekontoDayInPayment,
  readSkattekontoPaymentsTowards,
  skattekontoPaymentDayFor,
  skattekontoPaymentPaysDeclaration,
} from '../skattekonto-day'

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

  it('answers nothing when only unsigned orders exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [order('draft', '2026-12-11', null), order('approved', '2026-12-11', null)] })

    expect(await readSkattekontoPaymentsTowards(supabase as unknown as SupabaseClient, 'company-1', '2026-12-14')).toEqual([])
  })
})

describe('skattekontoPaymentPaysDeclaration', () => {
  it('is true for exactly the declared amount, to the öre', () => {
    expect(skattekontoPaymentPaysDeclaration(24568, 12000 + 12568)).toBe(true)
    expect(skattekontoPaymentPaysDeclaration(1234.56, 1234.56)).toBe(true)
  })

  it('is false for a larger payment: it may be another declaration due the same day', () => {
    expect(skattekontoPaymentPaysDeclaration(60000, 24568)).toBe(false)
  })

  it('is false for a smaller payment and for a declaration asking for nothing', () => {
    expect(skattekontoPaymentPaysDeclaration(24567.99, 24568)).toBe(false)
    expect(skattekontoPaymentPaysDeclaration(0, 0)).toBe(false)
  })
})
