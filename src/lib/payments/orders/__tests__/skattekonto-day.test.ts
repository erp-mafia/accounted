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
import { PAYMENT_ORDER_STATUSES, UNANSWERED_SIGNING_MINUTES } from '../status'

const NOW = Date.parse('2026-11-24T20:10:00Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
/** A signing nobody finished, started `minutes` before NOW. */
const openSigning = (minutes: number) => ({ status: 'awaiting_signature', signing_started_at: minutesBefore(minutes) })
/** A signing whose BankID finished `minutes` before NOW (the bank may still be confirming it). */
const finishedSigning = (minutes: number) => ({ status: 'signed', signing_started_at: minutesBefore(minutes) })

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
    signing: null,
  })

  it('reads from the banking day before the due date through the due date, earliest first', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [order('accepted', '2026-12-14'), order('draft', '2026-12-11', null), order('executed', '2026-12-11')] })

    const found = await readSkattekontoPaymentsTowards(supabase as unknown as SupabaseClient, 'company-1', '2026-12-14')

    expect(found.map((o) => o.id)).toEqual(['order-executed-2026-12-11', 'order-accepted-2026-12-14'])
    // The signing is read with the order, as Hem's cover rule reads it.
    expect(findCalls('payment_orders', 'select')).toEqual([
      [expect.stringContaining('signing:payment_order_batches!fk_payment_orders_batch(status, signing_started_at)')],
    ])
    expect(findCalls('payment_orders', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['purpose', 'skattekonto'],
    ])
    expect(findCalls('payment_orders', 'gte')).toEqual([['requested_execution_date', '2026-12-11']])
    expect(findCalls('payment_orders', 'lte')).toEqual([['requested_execution_date', '2026-12-14']])
    // Cancelled, failed and rejected orders pay nothing: never read.
    expect(findCalls('payment_orders', 'in')).toEqual([
      ['status', ['draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']],
    ])
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
    expect(isSkattekontoPaymentSigned(found[0], NOW)).toBe(false)
  })
})

describe('isSkattekontoPaymentSigned', () => {
  it('is true for an executed order and for one signed at the bank', () => {
    for (const status of ['awaiting_second_signer', 'accepted', 'executed']) {
      expect(isSkattekontoPaymentSigned({ status, signing: null }, NOW)).toBe(true)
    }
  })

  it('counts a payment waiting for its BankID while that signing can still finish, or once it finished', () => {
    expect(isSkattekontoPaymentSigned({ status: 'awaiting_signature', signing: openSigning(5) }, NOW)).toBe(true)
    // The BankID finalised and the bank is still confirming it, at any age.
    expect(isSkattekontoPaymentSigned({ status: 'awaiting_signature', signing: finishedSigning(8 * 24 * 60) }, NOW)).toBe(true)
  })

  it('does not count a BankID nobody finished once it can no longer finish, nor one with no signing known', () => {
    // Abandoned, and the status sync could not read the bank to move it on.
    expect(
      isSkattekontoPaymentSigned({ status: 'awaiting_signature', signing: openSigning(UNANSWERED_SIGNING_MINUTES) }, NOW),
    ).toBe(false)
    expect(isSkattekontoPaymentSigned({ status: 'awaiting_signature', signing: [openSigning(2 * 24 * 60)] }, NOW)).toBe(false)
    expect(isSkattekontoPaymentSigned({ status: 'awaiting_signature', signing: null }, NOW)).toBe(false)
  })

  it('is false for every other status, whatever its signing: unsigned at the bank (submitted) never executes', () => {
    const signedOrExecuted: readonly string[] = ['awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed']
    const others = PAYMENT_ORDER_STATUSES.filter((status) => !signedOrExecuted.includes(status))
    expect(others).toEqual(['draft', 'approved', 'submitted', 'rejected', 'cancelled', 'failed'])
    for (const status of others) {
      expect(isSkattekontoPaymentSigned({ status, signing: null }, NOW)).toBe(false)
      expect(isSkattekontoPaymentSigned({ status, signing: openSigning(1) }, NOW)).toBe(false)
    }
  })
})

describe('skattekontoPaymentPaysDeclaration', () => {
  const signed = (amount: number | string) => ({ status: 'accepted', amount, signing: null })

  it('is true for a signed payment of exactly the declared amount, to the öre', () => {
    expect(skattekontoPaymentPaysDeclaration(signed(24568), 12000 + 12568, NOW)).toBe(true)
    expect(skattekontoPaymentPaysDeclaration(signed('1234.56'), 1234.56, NOW)).toBe(true)
  })

  it('is true for every signed or executed status', () => {
    for (const status of ['awaiting_second_signer', 'accepted', 'executed']) {
      expect(skattekontoPaymentPaysDeclaration({ status, amount: '24568.00', signing: null }, 24568, NOW)).toBe(true)
    }
    expect(skattekontoPaymentPaysDeclaration({ status: 'awaiting_signature', amount: '24568.00', signing: openSigning(5) }, 24568, NOW)).toBe(
      true,
    )
  })

  it('is false for the exact amount unsigned: at the bank, claimed for signing, or a BankID left unfinished', () => {
    expect(skattekontoPaymentPaysDeclaration({ status: 'submitted', amount: '24568.00', signing: null }, 24568, NOW)).toBe(false)
    expect(skattekontoPaymentPaysDeclaration({ status: 'approved', amount: '24568.00', signing: null }, 24568, NOW)).toBe(false)
    expect(
      skattekontoPaymentPaysDeclaration(
        { status: 'awaiting_signature', amount: '24568.00', signing: openSigning(UNANSWERED_SIGNING_MINUTES + 30) },
        24568,
        NOW,
      ),
    ).toBe(false)
  })

  it('is false for a larger payment: it may be another declaration due the same day', () => {
    expect(skattekontoPaymentPaysDeclaration(signed(60000), 24568, NOW)).toBe(false)
  })

  it('is false for a smaller payment and for a declaration asking for nothing', () => {
    expect(skattekontoPaymentPaysDeclaration(signed(24567.99), 24568, NOW)).toBe(false)
    expect(skattekontoPaymentPaysDeclaration(signed(0), 0, NOW)).toBe(false)
  })
})
