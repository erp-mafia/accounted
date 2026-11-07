import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  PaymentProviderError,
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentCancelResult,
  type ProviderPaymentState,
} from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'
import type { PaymentOrderRow } from '../types'
import { batch, COMPANY, fakeProvider, USER, waitingOrder } from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/auth/resource-psu', () => ({
  storedBatchPsu: vi.fn().mockResolvedValue('198001019879'),
  storedBatchSigner: vi.fn().mockResolvedValue({ psuId: '198001019879', ipAddress: null }),
}))

import { cancelPaymentOrder, isReleasableUnsigned, RELEASE_UNSIGNED_AFTER_MINUTES, type CancelSigning } from '../lifecycle'

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

async function cancelAnswered(
  order: PaymentOrderRow,
  answer: PaymentCancelResult,
  signing?: string | Partial<CancelSigning>,
  options: { releaseUnsigned?: boolean; state?: ProviderPaymentState | Error } = {},
) {
  const { state, ...cancelOptions } = options
  const getPaymentState = state instanceof Error ? vi.fn().mockRejectedValue(state) : state ? vi.fn().mockResolvedValue(state) : undefined
  provider = fakeProvider({ cancelPayment: vi.fn().mockResolvedValue(answer), ...(getPaymentState ? { getPaymentState } : {}) })
  registerPaymentInitiationProvider(provider)
  db.setTable('payment_orders', { data: [order] })
  if (signing) db.setTable('payment_order_batches', { data: typeof signing === 'string' ? { status: signing } : signing })
  return cancelPaymentOrder(ctx, { orderId: order.id, ...cancelOptions })
}

let provider: ReturnType<typeof fakeProvider>

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

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

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_UNSIGNED_REFUSED', details: { releasable: false } })
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
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

  it('does not read the payment again: the unsigned release has its own path', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    await cancelAnswered(order, { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true })

    expect(provider.getPaymentState).not.toHaveBeenCalled()
  })
})

// crm#1699: SEB did not confirm the cancel of an unsigned payment, answered
// "not cancelled" to three retries, and had cancelled it a minute later,
// which only the 15-minute status sync picked up. Meanwhile the person was
// sent to an online bank that does not show unsigned payments.
describe('a cancel the bank does not confirm', () => {
  const RCVD: ProviderPaymentState = { providerStatus: 'RCVD', status: 'submitted', messages: [] }
  const NOT_CONFIRMED: PaymentCancelResult = { outcome: 'not_cancelled', providerStatus: null }
  const NEEDS_SIGNING: PaymentCancelResult = { outcome: 'needs_authorisation', providerStatus: 'ACTC' }

  it.each([
    ['not cancelled', NOT_CONFIRMED],
    ['wants the cancel signed', NEEDS_SIGNING],
  ])('the bank %s but its status read shows the payment cancelled: the order follows the bank at once', async (_name, answer) => {
    const order = waitingOrder('o1', 1, { status: 'awaiting_signature' })
    const outcome = await cancelAnswered(order, answer, 'awaiting_signature', {
      state: { providerStatus: 'CANC', status: 'cancelled', messages: [] },
    })

    expect(outcome).toEqual({ ok: true, data: { cancelled: true, status: 'cancelled' } })
    expect(provider.getPaymentState).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
    expect(db.findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'cancelled', provider_status: 'CANC' })
    // Compare-and-set on the status the order had, and who asked is on the event.
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'awaiting_signature'])
    const events = db.findCalls('payment_order_events', 'insert').flatMap((args) => args[0] as Array<Record<string, unknown>>)
    expect(events).toContainEqual(
      expect.objectContaining({ event_type: 'status_changed', from_status: 'awaiting_signature', to_status: 'cancelled', provider_status: 'CANC', actor_user_id: USER }),
    )
  })

  it('a payment the bank rejected closes as rejected, not as cancelled', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    const outcome = await cancelAnswered(order, NOT_CONFIRMED, undefined, {
      state: { providerStatus: 'RJCT', status: 'rejected', messages: [] },
    })

    expect(outcome).toEqual({ ok: true, data: { cancelled: false, status: 'rejected' } })
    expect(db.findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'rejected', provider_status: 'RJCT' })
  })

  it.each([
    ['submitted (its signing abandoned)', waitingOrder('o1', 1, { status: 'submitted' }), undefined, NOT_CONFIRMED],
    ['awaiting a signature nobody finished', waitingOrder('o1', 1, { status: 'awaiting_signature' }), 'awaiting_signature', NOT_CONFIRMED],
    ['submitted, the cancel wanting a signature', waitingOrder('o1', 1, { status: 'submitted' }), undefined, NEEDS_SIGNING],
  ] as const)('the bank still reports it unsigned, the order %s: says it is not paid without a signature, and changes nothing', async (_name, order, signing, answer) => {
    const outcome = await cancelAnswered(order, answer, signing, { state: RCVD })

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_PENDING_UNSIGNED', details: { payment_order_id: 'o1', provider_status: 'RCVD' } })
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
  })

  it.each([
    ['its BankID finished while the bank still answers RCVD', waitingOrder('o1', 1, { status: 'awaiting_signature' }), 'signed'],
    ['it carries a signature', waitingOrder('o1', 1, { status: 'submitted', signed_at: '2026-09-30T08:05:00Z' }), undefined],
    ['its signing cannot be read', waitingOrder('o1', 1, { status: 'awaiting_signature' }), undefined],
  ] as const)('never calls a payment unsigned when %s', async (_name, order, signing) => {
    const outcome = await cancelAnswered(order, NOT_CONFIRMED, signing, { state: RCVD })

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_NOT_CONFIRMED' })
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
  })

  it.each([
    ['accepted (signed)', { providerStatus: 'ACSP', status: 'accepted', messages: [] } as ProviderPaymentState],
    ['executed', { providerStatus: 'ACSC', status: 'executed', messages: [] } as ProviderPaymentState],
    ['unreadable', new PaymentProviderError('format', 'FORMAT_ERROR', false, 400)],
  ])('keeps the refusal as it was when the status read shows the payment %s', async (_name, state) => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })

    expect(await cancelAnswered(order, NOT_CONFIRMED, undefined, { state })).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_NOT_CONFIRMED' })
    expect(await cancelAnswered(order, NEEDS_SIGNING, undefined, { state })).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_NEEDS_SIGNING' })
    // Only a payment the bank closed unpaid moves here; the rest is the status sync's.
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
  })
})

// Danske Bank takes neither a cancel nor a new signing of a started payment
// through its API: an unsigned payment it holds stays RCVD for good, and the
// order with it, until a person releases it here (crm#1282).
describe('an unsigned payment the bank will not cancel (crm#1282)', () => {
  const RCVD: PaymentCancelResult = { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true }
  const abandoned = (minutes: number): Partial<CancelSigning> => ({ status: 'failed', signing_started_at: minutesAgo(minutes), signed_at: null })

  it('says the order may be released once its signing is long over, and changes nothing yet', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    const outcome = await cancelAnswered(order, RCVD, abandoned(60 * 24 * 10))

    expect(outcome).toMatchObject({ ok: false, code: 'PAYMENT_CANCEL_UNSIGNED_REFUSED', details: { payment_order_id: 'o1', releasable: true } })
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
  })

  it('releases it on request: cancelled here with the bank\'s word, its payment id kept, and says why', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    const outcome = await cancelAnswered(order, RCVD, abandoned(60 * 24 * 10), { releaseUnsigned: true })

    expect(outcome).toEqual({ ok: true, data: { cancelled: true, status: 'cancelled', released_unsigned: true } })
    expect(db.findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'cancelled', cancelled_by: USER, provider_status: 'RCVD' })
    // Only while the order is still that payment, and never clearing its id.
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'submitted'])
    expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['provider_payment_id', 'pay-1'])
    expect(db.findCall('payment_orders', 'update')?.[0]).not.toHaveProperty('provider_payment_id')
    const events = db.findCalls('payment_order_events', 'insert').flatMap((args) => args[0] as Array<Record<string, unknown>>)
    expect(events).toContainEqual(
      expect.objectContaining({
        event_type: 'cancelled',
        from_status: 'submitted',
        to_status: 'cancelled',
        actor_user_id: USER,
        detail: { provider_payment_id: 'pay-1', reason: 'UNSIGNED_AT_BANK_NOT_CANCELLABLE', released_unsigned: true },
      }),
    )
  })

  it('asks the bank again first and cancels as usual when it confirms this time', async () => {
    const order = waitingOrder('o1', 1, { status: 'submitted' })
    const outcome = await cancelAnswered(order, { outcome: 'cancelled', providerStatus: 'CANC' }, abandoned(120), { releaseUnsigned: true })

    expect(outcome).toEqual({ ok: true, data: { cancelled: true, status: 'cancelled' } })
    expect(db.findCall('payment_orders', 'update')?.[0]).toMatchObject({ status: 'cancelled', provider_status: 'CANC' })
  })

  it.each([
    ['a signing started minutes ago', waitingOrder('o1', 1, { status: 'submitted' }), RCVD, abandoned(5)],
    ['a signing still open', waitingOrder('o1', 1, { status: 'awaiting_signature' }), RCVD, { status: 'awaiting_signature', signing_started_at: minutesAgo(120), signed_at: null }],
    ['a signed payment the bank still reports received', waitingOrder('o1', 1, { status: 'awaiting_signature' }), RCVD, { status: 'signed', signing_started_at: minutesAgo(120), signed_at: minutesAgo(119) }],
    ['an accepted payment', waitingOrder('o1', 1, { status: 'accepted' }), RCVD, abandoned(120)],
    ['a payment the bank no longer reports unsigned', waitingOrder('o1', 1, { status: 'submitted' }), { outcome: 'too_late', providerStatus: 'ACSC', unsigned: false }, abandoned(120)],
    ['a signing that cannot be read', waitingOrder('o1', 1, { status: 'submitted' }), RCVD, undefined],
  ] as const)('never releases %s', async (_name, order, answer, signing) => {
    const outcome = await cancelAnswered(order, answer, signing as Partial<CancelSigning> | string | undefined, { releaseUnsigned: true })

    expect(outcome.ok).toBe(false)
    expect(db.findCall('payment_orders', 'update')).toBeUndefined()
  })
})

describe('isReleasableUnsigned', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z')
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
  const RCVD: PaymentCancelResult = { outcome: 'too_late', providerStatus: 'RCVD', unsigned: true }
  const order = (overrides: Partial<PaymentOrderRow> = {}) => waitingOrder('o1', 1, { status: 'submitted', submitted_at: ago(60 * 24), ...overrides })
  const signing = (overrides: Partial<CancelSigning> = {}): CancelSigning => ({ status: 'failed', signing_started_at: ago(60 * 24), signed_at: null, ...overrides })

  it('allows an unsigned payment whose signing ended long ago, in an abandoned or a stopped signing', () => {
    expect(isReleasableUnsigned(order(), signing(), RCVD, NOW)).toBe(true)
    expect(isReleasableUnsigned(order(), signing({ status: 'created' }), RCVD, NOW)).toBe(true)
    expect(isReleasableUnsigned(order(), signing(), { outcome: 'too_late', providerStatus: 'PDNG', unsigned: true }, NOW)).toBe(true)
  })

  it('counts from the last BankID start, a restart included', () => {
    const at = (minutes: number) => isReleasableUnsigned(order(), signing({ signing_started_at: ago(minutes) }), RCVD, NOW)
    expect(at(RELEASE_UNSIGNED_AFTER_MINUTES)).toBe(true)
    expect(at(RELEASE_UNSIGNED_AFTER_MINUTES - 1)).toBe(false)
    expect(isReleasableUnsigned(order({ submitted_at: ago(5) }), signing(), RCVD, NOW)).toBe(false)
  })

  it.each([
    ['awaiting a signature', { status: 'awaiting_signature' }],
    ['accepted', { status: 'accepted' }],
    ['executed', { status: 'executed' }],
    ['signed', { signed_at: ago(60) }],
    ['without a payment id', { provider_payment_id: null }],
    ['with a create in doubt', { outcome_unknown_at: ago(60) }],
  ] as const)('refuses an order %s', (_name, overrides) => {
    expect(isReleasableUnsigned(order(overrides as Partial<PaymentOrderRow>), signing(), RCVD, NOW)).toBe(false)
  })

  it.each([
    ['open', signing({ status: 'awaiting_signature' })],
    ['signed', signing({ status: 'signed' })],
    ['waiting for a second signer', signing({ status: 'awaiting_second_signer' })],
    ['with a signature on it', signing({ signed_at: ago(60) })],
    ['unread', null],
  ] as const)('refuses an order whose signing is %s', (_name, s) => {
    expect(isReleasableUnsigned(order(), s, RCVD, NOW)).toBe(false)
  })

  it('refuses any other bank answer', () => {
    expect(isReleasableUnsigned(order(), signing(), { outcome: 'too_late', providerStatus: 'ACSC', unsigned: false }, NOW)).toBe(false)
    expect(isReleasableUnsigned(order(), signing(), { outcome: 'not_cancelled', providerStatus: 'RCVD', unsigned: true }, NOW)).toBe(false)
    expect(isReleasableUnsigned(order(), signing(), { outcome: 'needs_authorisation', providerStatus: 'RCVD', unsigned: true }, NOW)).toBe(false)
    expect(isReleasableUnsigned(order(), signing(), { outcome: 'too_late', providerStatus: null }, NOW)).toBe(false)
  })

  it('allows an order without a signing on its claim time alone', () => {
    expect(isReleasableUnsigned(order({ batch_id: null }), null, RCVD, NOW)).toBe(true)
    expect(isReleasableUnsigned(order({ batch_id: null, submitted_at: ago(5) }), null, RCVD, NOW)).toBe(false)
  })
})
