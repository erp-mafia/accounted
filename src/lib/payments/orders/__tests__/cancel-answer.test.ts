import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { registerPaymentInitiationProvider, resetPaymentInitiationProviders, type PaymentCancelResult } from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'
import type { PaymentOrderRow } from '../types'
import { batch, COMPANY, fakeProvider, USER, waitingOrder } from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/auth/resource-psu', () => ({ storedBatchPsu: vi.fn().mockResolvedValue('198001019879') }))

import { cancelPaymentOrder } from '../lifecycle'

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  resetPaymentInitiationProviders()
  db = createTableMockSupabase({
    company_settings: { data: { org_number: '556677-8899' } },
    bankid_identities: { data: null },
    payment_signers: { data: null },
    payment_order_events: { data: null },
  })
  mock.supabase = db.supabase
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: USER, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never }
})

async function cancelAnswered(order: PaymentOrderRow, answer: PaymentCancelResult, signingStatus?: string) {
  registerPaymentInitiationProvider(fakeProvider({ cancelPayment: vi.fn().mockResolvedValue(answer) }))
  db.setTable('payment_orders', { data: [order] })
  if (signingStatus) db.setTable('payment_order_batches', { data: { status: signingStatus } })
  return cancelPaymentOrder(ctx, { orderId: order.id })
}

describe('a cancel the bank refuses as too late', () => {
  it('says the payment is unsigned, not executed, when the bank refused it during an open signing (crm#1282)', async () => {
    // The bank answered 405 to a cancel of a payment it reported RCVD while its
    // BankID (the bank's own page) was open: nothing had been paid.
    const order = waitingOrder('o1', 1, { status: 'awaiting_signature' })
    const outcome = await cancelAnswered(order, { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true }, 'awaiting_signature')

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_UNSIGNED_REFUSED', details: { payment_order_id: 'o1', provider_status: 'RCVD' } })
    expect(db.findCall('payment_order_batches', 'eq')).toBeDefined()
    // The order stays where it is: nothing is cancelled on a refusal.
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('says the same for a payment whose signing was abandoned and that waits unsigned', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    const outcome = await cancelAnswered(order, { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true })

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_UNSIGNED_REFUSED' })
    expect(db.tables()).not.toContain('payment_order_batches')
  })

  it('keeps too late for a payment whose BankID finished while the bank still answers RCVD', async () => {
    const order = waitingOrder('o1', 1, { status: 'awaiting_signature' })
    const outcome = await cancelAnswered(order, { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true }, batch({ status: 'signed' }).status)

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_TOO_LATE' })
  })

  it('keeps too late when the signing of an order awaiting signature cannot be read', async () => {
    const order = waitingOrder('o1', 1, { status: 'awaiting_signature' })
    const outcome = await cancelAnswered(order, { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true })

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_TOO_LATE' })
  })

  it.each([
    ['an accepted payment the bank executed', 'accepted', { outcome: 'too_late', providerStatus: 'ACSC', unsigned: false }],
    ['a signed payment the bank still reports received', 'accepted', { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true }],
    ['an unsigned payment whose status the bank did not give', 'submitted', { outcome: 'too_late', providerStatus: null }],
  ] as const)('keeps too late for %s', async (_name, status, answer) => {
    const order = waitingOrder('o1', 1, { status })
    const outcome = await cancelAnswered(order, answer)

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_TOO_LATE' })
  })

  it('leaves the other refusals as they were for an unsigned payment', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    expect(await cancelAnswered(order, { outcome: 'needs_authorisation', providerStatus: 'RCVD', unsigned: true })).toMatchObject({
      ok: false,
      code: 'PAYMENT_CANCEL_NEEDS_SIGNING',
    })
    expect(await cancelAnswered(order, { outcome: 'not_cancelled', providerStatus: 'RCVD', unsigned: true })).toMatchObject({
      ok: false,
      code: 'PAYMENT_CANCEL_NOT_CONFIRMED',
    })
  })
})
