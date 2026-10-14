import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}))
import { createTableMockSupabase } from '@/tests/helpers'
import { PaymentProviderError, registerPaymentInitiationProvider, resetPaymentInitiationProviders } from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'
import { sanitizedProviderMessage } from '../types'
import { batch, claimedOrder, COMPANY, fakeProvider, invoiceFor, order, SIGNER, USER, waitingOrder } from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown, storedBatchPsu: vi.fn(), rememberBatchPsu: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/auth/resource-psu', () => ({
  storedBatchPsu: (...a: unknown[]) => mock.storedBatchPsu(...a),
  rememberBatchPsu: (...a: unknown[]) => mock.rememberBatchPsu(...a),
}))

import { PERMANENT_SIGNING_FAILURES, pollPaymentSigning, restartPaymentSigning, startPaymentSigning } from '../signing'
import { PERMANENT_SIGNING_FAILURES as CLIENT_PERMANENT_SIGNING_FAILURES } from '@/components/payments/payment-order-status'

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }

beforeEach(() => {
  resetPaymentInitiationProviders()
  db = createTableMockSupabase({
    company_settings: { data: { org_number: '556677-8899' } },
    bankid_identities: { data: null },
    payment_order_events: { data: null },
    supplier_invoices: { data: ['o1', 'o2', 'o3'].map((id) => invoiceFor(id)) },
    'rpc:release_payment_order': { data: { ok: true, status: 'approved' } },
  })
  mock.supabase = db.supabase
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: USER, log: log as never }
  mock.storedBatchPsu.mockReset().mockResolvedValue(null)
  mock.rememberBatchPsu.mockReset().mockResolvedValue(undefined)
})

/** The PSU-ID a signing's payments were created with, as the earlier signing kept it. */
const KEPT_PSU = '198001019879'

function orderPatches(): Array<Record<string, unknown>> {
  return db.findCalls('payment_orders', 'update').map(([patch]) => patch as Record<string, unknown>)
}

function events(): Array<Record<string, unknown>> {
  return db.findCalls('payment_order_events', 'insert').flatMap(([rows]) => rows as Array<Record<string, unknown>>)
}

function releases(): Array<Record<string, unknown>> {
  return db.findCalls('rpc:release_payment_order', 'rpc').map(([args]) => args as Record<string, unknown>)
}

describe('startPaymentSigning', () => {
  it('writes the marker before each create, stores each id at once, bundles them in a basket and starts BankID', async () => {
    const markersAtCreate: number[] = []
    let n = 0
    const provider = fakeProvider({
      createPayment: vi.fn().mockImplementation(async () => {
        markersAtCreate.push(orderPatches().filter((p) => typeof p.create_started_at === 'string').length)
        n += 1
        return { providerPaymentId: `pay-${n}`, product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] }
      }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] }, // preview
      { data: [{ id: 'o1' }] }, // o1: create started
      { data: [{ id: 'o1' }] }, // o1: id stored
      { data: [{ id: 'o2' }] },
      { data: [{ id: 'o2' }] },
      { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] }, // beginSca: still waiting in this signing
      { data: null }, // -> awaiting_signature
      { data: [waitingOrder('o1', 1, { status: 'awaiting_signature' }), waitingOrder('o2', 2, { status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: [claimedOrder('o1'), claimedOrder('o2')] } })
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-at-bank' }) }, // basket stored
      { data: batch({ provider_batch_id: 'basket-at-bank' }) }, // beginSca load
      { data: batch({ provider_batch_id: 'basket-at-bank', status: 'awaiting_signature', provider_authorisation_id: 'auth-1' }) },
      { data: batch({ status: 'awaiting_signature' }) },
    ])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })

    expect(result.ok).toBe(true)
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.challenge?.qrData).toBe('bankid.qr.1')
    // Each create was preceded by its own marker, written before the bank was asked.
    expect(markersAtCreate).toEqual([1, 2])
    const stored = orderPatches().filter((p) => 'provider_payment_id' in p)
    expect(stored).toEqual([
      expect.objectContaining({ provider_payment_id: 'pay-1', create_started_at: null, outcome_unknown_at: null }),
      expect.objectContaining({ provider_payment_id: 'pay-2', create_started_at: null, outcome_unknown_at: null }),
    ])
    expect(db.findCalls('payment_orders', 'is')).toEqual(expect.arrayContaining([['create_started_at', null], ['outcome_unknown_at', null], ['provider_payment_id', null]]))
    expect(provider.createSigningBasket).toHaveBeenCalledWith(expect.anything(), ['pay-1', 'pay-2'])
    expect(provider.startSigning).toHaveBeenCalledWith(
      expect.objectContaining({ signerPersonalNumber: '199001011239', debtorBic: 'ESSESESS', companyOrgNumber: '556677-8899', accountContext: 'corporate', affiliatedAspspId: null }),
      { kind: 'basket', providerBasketId: 'basket-at-bank' },
      'qr',
      null,
    )
    const instruction = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(instruction).toMatchObject({ amount: 737.5, attempt: 1, payee: { type: 'bankgiro', bankgiro: '50501055' }, reference: { type: 'ocr', value: '4400112233' } })
    expect(db.supabase.rpc).toHaveBeenCalledWith('claim_payment_orders_for_signing', expect.objectContaining({ p_company_id: COMPANY, p_user_id: USER }))
    // The bank holds payments created with this PSU-ID: kept once for the signing, never read for new payments.
    expect(mock.rememberBatchPsu).toHaveBeenCalledTimes(1)
    expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: 'batch-1', companyId: COMPANY, personalNumber: '199001011239' })
    expect(mock.storedBatchPsu).not.toHaveBeenCalled()
  })

  it('numbers a create after the payments the bank confirmed cancelled for the order, so a new key makes a new payment', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    // o1 had two payments cancelled at the bank before (two provider_cancelled events); o2 none.
    db.setTable('payment_order_events', { data: [{ payment_order_id: 'o1' }, { payment_order_id: 'o1' }] })
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [{ id: 'o2' }] },
      { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] },
      { data: null },
      { data: [waitingOrder('o1', 1, { status: 'awaiting_signature' }), waitingOrder('o2', 2, { status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: [claimedOrder('o1'), claimedOrder('o2')] } })
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank', status: 'awaiting_signature', provider_authorisation_id: 'auth-1' }) },
      { data: batch({ status: 'awaiting_signature' }) },
    ])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })

    expect(result.ok).toBe(true)
    const attempts = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls.map(([, instruction]) => (instruction as { endToEndId: string; attempt: number }).attempt)
    expect(attempts).toEqual([3, 1])
    expect(db.findCalls('payment_order_events', 'eq')).toContainEqual(['event_type', 'provider_cancelled'])
  })

  it('re-attests an approved order whose day is no banking day before the bank is asked', async () => {
    const provider = fakeProvider({
      createPayment: vi.fn().mockResolvedValue({ providerPaymentId: 'pay-1', product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1', { requested_execution_date: '2026-10-11' }), order('o2')] }, // preview: o1 on a Saturday
      { data: [{ id: 'o1' }] }, // o1 back to draft
      { data: [{ id: 'o1' }] }, // o1 date
      { data: [{ id: 'o1' }] }, // o1 approved again
      { data: [{ id: 'o1' }] }, // o1: create started
      { data: [{ id: 'o1' }] }, // o1: id stored
      { data: [{ id: 'o2' }] },
      { data: [{ id: 'o2' }] },
      { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] },
      { data: null },
      { data: [waitingOrder('o1', 1, { status: 'awaiting_signature' }), waitingOrder('o2', 2, { status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', {
      data: { ok: true, batch: batch(), orders: [claimedOrder('o1', { requested_execution_date: '2026-10-12' }), claimedOrder('o2')] },
    })
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank', status: 'awaiting_signature', provider_authorisation_id: 'auth-1' }) },
      { data: batch({ status: 'awaiting_signature' }) },
    ])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER, today: '2026-10-11' })

    expect(result.ok).toBe(true)
    const patches = orderPatches()
    expect(patches[0]).toMatchObject({ status: 'draft', approved_by: null })
    expect(patches[1]).toEqual({ requested_execution_date: '2026-10-12' })
    expect(patches[2]).toMatchObject({ status: 'approved', approved_by: USER })
    expect(events().filter((e) => e.payment_order_id === 'o1').map((e) => e.event_type)).toEqual(expect.arrayContaining(['unapproved', 'approved']))
    const instruction = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { requestedExecutionDate: string }
    expect(instruction.requestedExecutionDate).toBe('2026-10-12')
  })

  it('sends nothing for an order that moved before its create could be marked', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('payment_orders', [
      { data: [order('o1')] },
      { data: [] }, // the marker matched nothing: the sweep released it
      { data: [] }, // stopSigning: nothing left in the signing
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' })
    expect(provider.createPayment).not.toHaveBeenCalled()
    expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([{ status: 'failed' }])
  })

  it('checks the bank and the company verification before claiming anything', async () => {
    const unverified = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'invalid', validUntil: null }) })
    registerPaymentInitiationProvider(unverified)
    db.setTable('payment_orders', { data: [order('o1')] })
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })).toMatchObject({
      ok: false,
      code: 'PAYMENT_COMPANY_VERIFICATION_REQUIRED',
    })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(unverified.createPayment).not.toHaveBeenCalled()
    // The provider's answer is stored, so the pages and the worklist know it without asking again.
    expect(db.findCall('company_payment_verifications', 'upsert')?.[0]).toMatchObject({ company_id: ctx.companyId, status: 'invalid', valid_until: null })
  })

  it('signs on when storing the verification answer fails', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    db.setTable('company_payment_verifications', { error: { message: 'boom' } })
    db.setTable('payment_orders', { data: [order('o1')] })
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: false, code: 'not_approved' } })
    // Past the verification gate: the claim was reached (and refused by the fixture).
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
    expect(ctx.log.warn).toHaveBeenCalledWith('payments verification not stored at signing', { err: 'boom' })
  })

  it('asks for the company verification in the corporate context only (DECISIONS.md 2026-10-12)', async () => {
    const unverified = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'invalid', validUntil: null }) })
    registerPaymentInitiationProvider(unverified)
    const personal = { ...order('o1').debtor_snapshot, bic: 'SWEDSESS', affiliated_aspsp_id: '08999', psu_type: 'personal' }
    db.setTable('payment_orders', { data: [order('o1', { debtor_snapshot: personal })] })
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: false, code: 'not_approved' } })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    // Past the gate: the claim was reached (and refused by the fixture), the verification never asked for.
    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
    expect(unverified.getCompanyVerification).not.toHaveBeenCalled()
    expect(unverified.getBankCapabilities).toHaveBeenCalledWith(expect.objectContaining({ accountContext: 'private', affiliatedAspspId: '08999', debtorBic: 'SWEDSESS' }))
  })

  it.each([
    ['a bank that signs neither in our screen nor on its own page', { decoupled: false, redirect: false, basket: { supported: true, maxPayments: 100 } }, 2, 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED', undefined],
    ['a bank without baskets, for several payments', { decoupled: true, redirect: false, basket: { supported: false, maxPayments: null } }, 2, 'PAYMENT_SIGNING_BASKET_UNSUPPORTED', { max: 1 }],
    ["a basket above the bank's maximum", { decoupled: true, redirect: false, basket: { supported: true, maxPayments: 2 } }, 3, 'PAYMENT_SIGNING_BASKET_TOO_LARGE', { max: 2 }],
  ])('refuses %s before anything is created', async (_name, capabilities, count, code, details) => {
    const provider = fakeProvider({ getBankCapabilities: vi.fn().mockResolvedValue(capabilities) })
    registerPaymentInitiationProvider(provider)
    const ids = ['o1', 'o2', 'o3'].slice(0, count)
    db.setTable('payment_orders', { data: ids.map((id) => order(id)) })

    const result = await startPaymentSigning(ctx, { orderIds: ids, method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code, ...(details ? { details } : {}) })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(provider.createPayment).not.toHaveBeenCalled()
  })

  describe("a bank that signs only on its own page", () => {
    const REDIRECT_ONLY = { decoupled: false, redirect: true, basket: { supported: true, maxPayments: 100 } }
    const single = batch({ signing_target: 'payment', order_count: 1 })
    const redirectChallenge = { approach: 'decoupled' as const, autostartToken: null, qrData: null, qrImage: null, redirectUrl: 'https://bank.example.se/sign/1' }

    function sendsOne(provider: ReturnType<typeof fakeProvider>) {
      db.setTable('payment_orders', [
        { data: [order('o1')] },
        { data: [{ id: 'o1' }] },
        { data: [{ id: 'o1' }] },
        { data: [waitingOrder('o1', 1)] },
        { data: null },
        { data: [waitingOrder('o1', 1, { status: 'awaiting_signature' })] },
      ])
      db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
      db.setTable('payment_order_batches', [{ data: single }, { data: { ...single, status: 'awaiting_signature', provider_authorisation_id: 'auth-1' } }, { data: single }])
      registerPaymentInitiationProvider(provider)
    }

    it('signs by redirect whatever was asked, tells the bank it prefers its page, and names Betalningar as the way back', async () => {
      const provider = fakeProvider({
        getBankCapabilities: vi.fn().mockResolvedValue(REDIRECT_ONLY),
        startSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-1', method: 'redirect', state: 'pending', challenge: { ...redirectChallenge, approach: 'redirect' }, failureCode: null }),
      })
      sendsOne(provider)

      const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER, returnOrigin: 'https://app.accounted.se' })

      expect(result).toMatchObject({ ok: true, data: { challenge: { approach: 'redirect', redirectUrl: 'https://bank.example.se/sign/1' } } })
      expect(provider.createPayment).toHaveBeenCalledWith(expect.objectContaining({ redirectPreferred: true }), expect.anything())
      expect(provider.startSigning).toHaveBeenCalledWith(
        expect.objectContaining({ redirectPreferred: true }),
        { kind: 'payment', providerPaymentId: 'pay-1', product: 'swedish-giro' },
        'redirect',
        { returnUrl: 'https://app.accounted.se/payments?signing=batch-1', returnState: 'batch-1' },
      )
      expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([expect.objectContaining({ signing_method: 'redirect' })])
    })

    it('refuses before anything is claimed when no origin to come back to is known', async () => {
      const provider = fakeProvider({ getBankCapabilities: vi.fn().mockResolvedValue(REDIRECT_ONLY) })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_orders', { data: [order('o1')] })

      const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'return_origin' } })
      expect(db.supabase.rpc).not.toHaveBeenCalled()
      expect(provider.createPayment).not.toHaveBeenCalled()
    })

    it('does not ask a bank that signs in our screen for its page, and takes QR when its page was asked for but it has none', async () => {
      const provider = fakeProvider({ getBankCapabilities: vi.fn().mockResolvedValue({ decoupled: true, redirect: false, basket: { supported: true, maxPayments: 100 } }) })
      sendsOne(provider)

      await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'redirect', signer: SIGNER, returnOrigin: 'https://app.accounted.se' })

      expect(provider.createPayment).toHaveBeenCalledWith(expect.not.objectContaining({ redirectPreferred: true }), expect.anything())
      expect(provider.startSigning).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'qr', null)
    })

    it('lets a person choose the bank page at a bank that offers both', async () => {
      const provider = fakeProvider({
        startSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-1', method: 'redirect', state: 'pending', challenge: { ...redirectChallenge, approach: 'redirect' }, failureCode: null }),
      })
      sendsOne(provider)

      await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'redirect', signer: SIGNER, returnOrigin: 'https://app.accounted.se' })

      expect(provider.startSigning).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'redirect', { returnUrl: 'https://app.accounted.se/payments?signing=batch-1', returnState: 'batch-1' })
      // Only a bank that signs nowhere else is told to prefer its page.
      expect(provider.createPayment).toHaveBeenCalledWith(expect.not.objectContaining({ redirectPreferred: true }), expect.anything())
    })

    it("comes back to the payment signing link's own page when the token route names it", async () => {
      const provider = fakeProvider({
        startSigning: vi.fn().mockResolvedValue({ providerAuthorisationId: 'auth-1', method: 'redirect', state: 'pending', challenge: { ...redirectChallenge, approach: 'redirect' }, failureCode: null }),
      })
      sendsOne(provider)

      await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'redirect', signer: SIGNER, returnOrigin: 'https://app.accounted.se', returnPath: '/betala/tok' })

      expect(provider.startSigning).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'redirect', { returnUrl: 'https://app.accounted.se/betala/tok?signing=batch-1', returnState: 'batch-1' })
    })

    it('on the payment signing link signs with the typed number only, and never remembers it for the sender', async () => {
      const provider = fakeProvider()
      sendsOne(provider)

      const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: { ...SIGNER, lookupOnFile: false }, returnOrigin: 'https://app.accounted.se' })

      expect(result.ok).toBe(true)
      expect(provider.startSigning).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: '199001011239' }), expect.anything(), 'qr', null)
      expect(db.tables()).not.toContain('payment_signers')
      expect(db.tables()).not.toContain('bankid_identities')
      // Not remembered for the sender, but kept for this signing: its payments were created with it.
      expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: single.id, companyId: COMPANY, personalNumber: '199001011239' })
    })
  })

  it("never lets the sender's number on file stand in on the payment signing link", async () => {
    registerPaymentInitiationProvider(fakeProvider())
    db.setTable('payment_orders', { data: [order('o1')] })
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: { ...SIGNER, personalNumber: null, lookupOnFile: false } })).toMatchObject({
      ok: false,
      code: 'PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED',
    })
    expect(db.tables()).not.toContain('bankid_identities')
    expect(db.tables()).not.toContain('payment_signers')
    // A session looks the person's own number up.
    await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: { ...SIGNER, personalNumber: null } })
    expect(db.tables()).toContain('bankid_identities')
  })

  it('on a definitive refusal mid-basket, cancels the payments already created at the bank, then releases them', async () => {
    const provider = fakeProvider({
      createPayment: vi
        .fn()
        .mockResolvedValueOnce({ providerPaymentId: 'pay-1', product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] })
        .mockRejectedValueOnce(new PaymentProviderError('Creditor account invalid', 'FORMAT_ERROR', false, 400)),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2'), order('o3')] }, // preview
      { data: [{ id: 'o1' }] }, // o1 marked
      { data: [{ id: 'o1' }] }, // o1 id stored
      { data: [{ id: 'o2' }] }, // o2 marked
      { data: [{ id: 'o2' }] }, // o2 failed
      { data: [waitingOrder('o1', 1), claimedOrder('o2', { status: 'failed' }), claimedOrder('o3')] }, // stopSigning reads the signing
      { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } }, // o1 still this payment in this signing
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', {
      data: { ok: true, batch: batch({ order_count: 3 }), orders: [claimedOrder('o1'), claimedOrder('o2'), claimedOrder('o3')] },
    })
    db.setTable('payment_order_batches', { data: batch({ order_count: 3 }) })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 'o2', 'o3'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR', payment_order_id: 'o2' } })
    expect(provider.createPayment).toHaveBeenCalledTimes(2)
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
    expect(provider.createSigningBasket).not.toHaveBeenCalled()
    expect(provider.startSigning).not.toHaveBeenCalled()
    // The confirmed cancel and the release go to the database together; the
    // order never created is released, the refused one failed with its answer.
    expect(releases()).toEqual([
      expect.objectContaining({ p_order_id: 'o1', p_batch_id: 'batch-1', p_provider_payment_id: 'pay-1', p_provider_status: 'CANC', p_user_id: USER }),
      expect.objectContaining({ p_order_id: 'o3', p_provider_payment_id: null }),
    ])
    expect(orderPatches()).toContainEqual(
      expect.objectContaining({ status: 'failed', create_started_at: null, provider_error_code: 'FORMAT_ERROR', provider_error_message: 'Creditor account invalid' }),
    )
    expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([{ status: 'failed' }])
  })

  it.each([
    ['answers that the cancel needs signing', vi.fn().mockResolvedValue({ outcome: 'needs_authorisation', providerStatus: 'RCVD' }), 'needs_authorisation'],
    ['cannot be reached for the cancel', vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503)), 'no_answer'],
  ])('keeps an order with its payment when the bank %s', async (_name, cancelPayment, answer) => {
    const provider = fakeProvider({
      createPayment: vi
        .fn()
        .mockResolvedValueOnce({ providerPaymentId: 'pay-1', product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] })
        .mockRejectedValueOnce(new PaymentProviderError('refused', 'FORMAT_ERROR', false, 400)),
      cancelPayment,
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [{ id: 'o2' }] }, // o2 failed
      { data: [waitingOrder('o1', 1), claimedOrder('o2', { status: 'failed' })] },
      { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: [claimedOrder('o1'), claimedOrder('o2')] } })
    db.setTable('payment_order_batches', { data: batch() })

    await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })

    expect(releases()).toEqual([])
    expect(events()).toContainEqual(
      expect.objectContaining({ payment_order_id: 'o1', event_type: 'error', detail: expect.objectContaining({ code: 'BANK_CANCEL_NOT_CONFIRMED', answer }) }),
    )
  })

  it('releases, never fails, an order whose create failed before it reached the bank', async () => {
    const provider = fakeProvider({ createPayment: vi.fn().mockRejectedValue(new PaymentProviderError('busy', 'RATE_LIMITED', true, 429)) })
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }, { data: [] }])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    // The bank's answer ends the create: the database lets the marker go only with it.
    expect(releases()).toEqual([expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: null, p_error_code: 'RATE_LIMITED', p_reason: 'CREATE_NOT_SENT' })])
    expect(orderPatches().some((p) => p.status === 'failed')).toBe(false)
    expect(provider.createPayment).toHaveBeenCalledTimes(1)
    // No payment exists at the bank: no PSU-ID is kept.
    expect(mock.rememberBatchPsu).not.toHaveBeenCalled()
  })

  it.each([
    ['a timeout after the request was sent', new PaymentProviderError('timeout', 'TIMEOUT', false, null, true), 'TIMEOUT'],
    ["an error that is not the provider's", new TypeError('socket hang up'), 'UNEXPECTED_ERROR'],
  ])('holds the order as outcome unknown on %s, and never fails or re-approves it', async (_name, error, code) => {
    const provider = fakeProvider({
      createPayment: vi
        .fn()
        .mockResolvedValueOnce({ providerPaymentId: 'pay-1', product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] })
        .mockRejectedValueOnce(error),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [{ id: 'o2' }] }, // o2 held
      { data: [waitingOrder('o1', 1), claimedOrder('o2', { outcome_unknown_at: '2026-09-30T08:01:00Z' })] },
      { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: [claimedOrder('o1'), claimedOrder('o2')] } })
    db.setTable('payment_order_batches', { data: batch() })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_OUTCOME_UNKNOWN', details: { payment_order_id: 'o2' } })
    const held = orderPatches().find((p) => typeof p.outcome_unknown_at === 'string')
    expect(held).toMatchObject({ provider_error_code: code, create_started_at: null })
    expect(orderPatches().some((p) => p.status === 'failed')).toBe(false)
    expect(events()).toContainEqual(expect.objectContaining({ payment_order_id: 'o2', event_type: 'outcome_unknown' }))
    // The payment that does exist is cancelled at the bank before its order is released; o2 is left alone.
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
    expect(releases().map((r) => r.p_order_id)).toEqual(['o1'])
  })

  it('takes an id whose store answer was lost as stored', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('payment_orders', [
      { data: [order('o1')] },
      { data: [{ id: 'o1' }] }, // marked
      { error: { message: 'connection reset' } }, // store: no answer
      { data: { provider_payment_id: 'pay-1' } }, // read back: it landed
      { data: [waitingOrder('o1', 1)] }, // beginSca
      { data: null },
      { data: [waitingOrder('o1', 1, { status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', [{ data: single }, { data: { ...single, status: 'awaiting_signature' } }, { data: single }])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result.ok).toBe(true)
    expect(provider.createPayment).toHaveBeenCalledTimes(1)
    expect(provider.cancelPayment).not.toHaveBeenCalled()
  })

  it.each([
    ['confirmed', { outcome: 'cancelled', providerStatus: 'CANC' }, 'PAYMENT_PROVIDER_UNAVAILABLE'],
    ['not confirmed', { outcome: 'not_cancelled', providerStatus: 'RCVD' }, 'PAYMENT_ORDERS_OUTCOME_UNKNOWN'],
  ])('logs the bank id when it cannot be stored and cancels the orphan, releasing the order only when the cancel is %s', async (_name, cancelAnswer, code) => {
    const provider = fakeProvider({ cancelPayment: vi.fn().mockResolvedValue(cancelAnswer) })
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('payment_orders', [
      { data: [order('o1')] },
      { data: [{ id: 'o1' }] }, // marked
      { data: [] }, // store matched nothing
      { data: { provider_payment_id: null } },
      { data: [] }, // second store
      { data: { provider_payment_id: null } },
      { data: [{ id: 'o1' }] }, // held, when the orphan is not cancelled
      { data: [] }, // stopSigning
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code })
    expect(log.error).toHaveBeenCalledWith(
      'bank payment created but its id could not be stored',
      undefined,
      expect.objectContaining({ orderId: 'o1', providerPaymentId: 'pay-1' }),
    )
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
    if (cancelAnswer.outcome === 'cancelled') {
      expect(events()).toContainEqual(expect.objectContaining({ event_type: 'provider_cancelled', detail: { provider_payment_id: 'pay-1', orphan: true } }))
      expect(releases()).toEqual([expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: null, p_error_code: 'PROVIDER_ID_NOT_STORED' })])
    } else {
      expect(releases()).toEqual([])
      expect(orderPatches().at(-1)).toMatchObject({ provider_error_code: 'PROVIDER_ID_NOT_STORED', create_started_at: null })
    }
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('cancels the payments and releases the orders when BankID cannot start for good', async () => {
    const provider = fakeProvider({
      startSigning: vi.fn().mockRejectedValue(new PaymentProviderError('rights', 'PSU_RIGHTS_MISSING', false, 403)),
    })
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('payment_orders', [
      { data: [order('o1')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o1' }] },
      { data: [waitingOrder('o1', 1)] }, // beginSca
      { data: [waitingOrder('o1', 1)] }, // stopSigning reads the signing
      { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'PSU_RIGHTS_MISSING' } })
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
    expect(releases()).toEqual([expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: 'pay-1' })])
    expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([{ status: 'failed' }])
  })

  it('undoes nothing when the start of BankID has an unknown outcome', async () => {
    const provider = fakeProvider({
      startSigning: vi.fn().mockRejectedValue(new PaymentProviderError('timeout', 'TIMEOUT', false, null, true)),
    })
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o1' }] }, { data: [waitingOrder('o1', 1)] }])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { outcome_unknown: true } })
    expect(provider.cancelPayment).not.toHaveBeenCalled()
    expect(db.findCalls('payment_order_batches', 'update')).toEqual([])
  })

  it('never starts BankID for an invoice paid another way since the claim', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    db.setTable('supplier_invoices', { data: [invoiceFor('o1', { status: 'paid', remaining_amount: 0 })] })
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o1' }] }, { data: [waitingOrder('o1', 1)] }])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE', details: { orders: ['o1'] } })
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('refuses without a signer personnummer and with orders that are not approved', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    db.setTable('payment_orders', { data: [order('o1')] })
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: { ...SIGNER, personalNumber: null } })).toMatchObject({
      ok: false,
      code: 'PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED',
    })
    db.setTable('payment_orders', { data: [order('o1', { status: 'draft' })] })
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_WRONG_STATUS',
    })
  })

  it('maps the claim refusals to their own codes', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    db.setTable('payment_orders', { data: [order('o1'), order('o2')] })
    db.setTable('rpc:claim_payment_orders_for_signing', [
      { data: { ok: false, code: 'mixed_currency' } },
      { data: { ok: false, code: 'ineligible', details: [{ id: 'o1', reason: 'not_payable' }] } },
      { data: { ok: false, code: 'invalid_payload' } },
    ])
    for (const code of ['PAYMENT_ORDERS_MIXED_CURRENCY', 'PAYMENT_ORDERS_INELIGIBLE', 'VALIDATION_ERROR']) {
      expect(await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })).toMatchObject({ ok: false, code })
    }
  })

  it('is unavailable without a registered provider', async () => {
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })).toMatchObject({ ok: false, code: 'PAYMENTS_UNAVAILABLE' })
  })
})

describe('restartPaymentSigning', () => {
  const restart = () => restartPaymentSigning(ctx, { batchId: 'batch-1', method: 'qr', signer: SIGNER })

  it('starts the same signing again through the database, which re-checks every invoice under lock', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const same = batch({ provider_batch_id: 'basket-old' })
    const both = [waitingOrder('o1', 1), waitingOrder('o2', 2)]
    db.setTable('payment_order_batches', [{ data: same }, { data: same }, { data: same }, { data: { ...same, status: 'awaiting_signature' } }, { data: same }])
    db.setTable('payment_orders', [{ data: both }, { data: both }, { data: both }, { data: null }, { data: both }])
    db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: true, batch: same, orders: both } })

    const result = await restart()

    expect(result).toMatchObject({ ok: true, data: { batch_id: 'batch-1' } })
    expect(db.supabase.rpc).toHaveBeenCalledWith('rebatch_payment_orders_for_signing', { p_company_id: COMPANY, p_batch_id: 'batch-1', p_user_id: USER })
    expect(provider.createSigningBasket).not.toHaveBeenCalled()
    expect(provider.startSigning).toHaveBeenCalledWith(expect.anything(), { kind: 'basket', providerBasketId: 'basket-old' }, 'qr', null)
  })

  it('never signs the same signing again for an invoice paid meanwhile', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const same = batch({ provider_batch_id: 'basket-old' })
    const both = [waitingOrder('o1', 1), waitingOrder('o2', 2)]
    db.setTable('payment_order_batches', { data: same })
    db.setTable('payment_orders', { data: both })
    db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: false, code: 'ineligible', details: [{ id: 'o2', reason: 'not_payable' }] } })

    expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE' })
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('signs the payments still waiting in a new signing when an order dropped out, without new payments', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const next = batch({ id: 'batch-2', signing_target: 'payment', order_count: 1 })
    const old = [waitingOrder('o1', 1), claimedOrder('o2', { status: 'cancelled', provider_payment_id: 'pay-2' })]
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-old' }) },
      { data: batch({ provider_batch_id: 'basket-old' }) },
      { data: next },
      { data: { ...next, status: 'awaiting_signature', provider_authorisation_id: 'auth-1' } },
      { data: next },
    ])
    db.setTable('payment_orders', [
      { data: old },
      { data: old },
      { data: [waitingOrder('o1', 1, { batch_id: 'batch-2' })] },
      { data: null },
      { data: [waitingOrder('o1', 1, { batch_id: 'batch-2', status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: false, batch: next, orders: [waitingOrder('o1', 1, { batch_id: 'batch-2' })] } })

    const result = await restart()

    expect(result).toMatchObject({ ok: true, data: { batch_id: 'batch-2' } })
    expect(provider.startSigning).toHaveBeenCalledWith(expect.anything(), { kind: 'payment', providerPaymentId: 'pay-1', product: 'swedish-giro' }, 'qr', null)
    expect(provider.createPayment).not.toHaveBeenCalled()
    expect(provider.createSigningBasket).not.toHaveBeenCalled()
  })

  it('sends the kept PSU-ID on the restart\'s reads and BankID, and keeps it for a new signing over the same payments', async () => {
    mock.storedBatchPsu.mockResolvedValue(KEPT_PSU)
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const next = batch({ id: 'batch-2', signing_target: 'payment', order_count: 1 })
    const old = [waitingOrder('o1', 1), claimedOrder('o2', { status: 'cancelled', provider_payment_id: 'pay-2' })]
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-old' }) },
      { data: batch({ provider_batch_id: 'basket-old' }) },
      { data: next },
      { data: { ...next, status: 'awaiting_signature', provider_authorisation_id: 'auth-1' } },
      { data: next },
    ])
    db.setTable('payment_orders', [
      { data: old },
      { data: old },
      { data: [waitingOrder('o1', 1, { batch_id: 'batch-2' })] },
      { data: null },
      { data: [waitingOrder('o1', 1, { batch_id: 'batch-2', status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: false, batch: next, orders: [waitingOrder('o1', 1, { batch_id: 'batch-2' })] } })

    // The person typed another number: the payments were created with the kept one, which goes.
    const result = await restart()

    expect(result).toMatchObject({ ok: true, data: { batch_id: 'batch-2' } })
    expect(mock.storedBatchPsu).toHaveBeenCalledWith('batch-1')
    expect(provider.getPaymentState).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU, psuIpAddress: '203.0.113.10' }), 'pay-1', 'swedish-giro')
    expect(provider.startSigning).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU }), expect.anything(), 'qr', null)
    expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: 'batch-2', companyId: COMPANY, personalNumber: KEPT_PSU })
  })

  it('signs nothing while a create of the signing has not ended', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: batch() })
    db.setTable('payment_orders', { data: [waitingOrder('o1', 1), claimedOrder('o2', { create_started_at: '2026-09-30T08:00:30Z' })] })

    expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_ORDER_CREATE_IN_PROGRESS' })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(provider.getPaymentState).not.toHaveBeenCalled()
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('reads each payment first: the bank cancelled one (it lets go), executed another (it moves on)', async () => {
    const provider = fakeProvider({
      getPaymentState: vi
        .fn()
        .mockResolvedValueOnce({ providerStatus: 'CANC', status: 'cancelled', messages: [] })
        .mockResolvedValueOnce({ providerStatus: 'ACSC', status: 'executed', messages: [] }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: batch({ provider_batch_id: 'basket-old' }) })
    db.setTable('payment_orders', [
      { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] },
      { data: [{ id: 'o2' }] }, // o2 -> executed
      { data: [] }, // nothing waits any more
    ])

    const result = await restart()

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_NOTHING_TO_SIGN' })
    expect(releases()).toEqual([
      expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: 'pay-1', p_provider_status: 'CANC', p_reason: 'BANK_REPORTS_CANCELLED' }),
    ])
    expect(orderPatches()).toContainEqual(expect.objectContaining({ status: 'executed', provider_status: 'ACSC' }))
    expect(db.findCalls('rpc:rebatch_payment_orders_for_signing', 'rpc')).toEqual([])
  })

  it('holds the signing when a payment status cannot be read', async () => {
    const provider = fakeProvider({ getPaymentState: vi.fn().mockRejectedValue(new PaymentProviderError('timeout', 'TIMEOUT', false, null, true)) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: batch({ provider_batch_id: 'basket-old' }) })
    db.setTable('payment_orders', { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] })

    expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE', details: { payment_order_id: 'o1' } })
    expect(releases()).toEqual([])
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it("tells the bank which sparbank and which account context the paying account's connection has", async () => {
    const provider = fakeProvider({ getPaymentState: vi.fn().mockRejectedValue(new PaymentProviderError('timeout', 'TIMEOUT', false, null, true)) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: batch({ provider_batch_id: 'basket-old' }) })
    const sparbank = { ...waitingOrder('o1', 1).debtor_snapshot, bic: 'SWEDSESS', bank_name: 'Sparbanken Skåne', affiliated_aspsp_id: '08999', psu_type: 'personal' }
    db.setTable('payment_orders', { data: [waitingOrder('o1', 1, { debtor_snapshot: sparbank })] })

    await restart()

    expect(provider.getPaymentState).toHaveBeenCalledWith(
      expect.objectContaining({ debtorBic: 'SWEDSESS', affiliatedAspspId: '08999', accountContext: 'private' }),
      'pay-1',
      'swedish-giro',
    )
  })

  it('cancels at the bank a waiting payment whose invoice no longer needs paying, and signs the rest', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    db.setTable('supplier_invoices', { data: [invoiceFor('o1'), invoiceFor('o2', { status: 'paid', remaining_amount: 0 })] })
    db.setTable('rpc:release_payment_order', { data: { ok: true, status: 'cancelled' } })
    const next = batch({ id: 'batch-2', signing_target: 'payment', order_count: 1 })
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-old' }) },
      { data: batch({ provider_batch_id: 'basket-old' }) },
      { data: next },
      { data: { ...next, status: 'awaiting_signature', provider_authorisation_id: 'auth-1' } },
      { data: next },
    ])
    db.setTable('payment_orders', [
      { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] },
      { data: { id: 'o2' } }, // o2 still waits with its payment
      { data: [waitingOrder('o1', 1)] },
      { data: [waitingOrder('o1', 1, { batch_id: 'batch-2' })] },
      { data: null },
      { data: [waitingOrder('o1', 1, { batch_id: 'batch-2', status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: false, batch: next, orders: [waitingOrder('o1', 1, { batch_id: 'batch-2' })] } })

    const result = await restart()

    expect(result).toMatchObject({ ok: true, data: { batch_id: 'batch-2' } })
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-2', 'swedish-giro')
    expect(releases()).toEqual([expect.objectContaining({ p_order_id: 'o2', p_provider_payment_id: 'pay-2', p_reason: 'INVOICE_CLOSED' })])
    expect(provider.startSigning).toHaveBeenCalledWith(expect.anything(), { kind: 'payment', providerPaymentId: 'pay-1', product: 'swedish-giro' }, 'qr', null)
  })

  describe('after the bank let the BankID expire', () => {
    const signedOnce = batch({ signing_target: 'payment', order_count: 1, provider_authorisation_id: 'auth-old' })
    const fresh = batch({ id: 'batch-2', signing_target: 'payment', order_count: 1 })
    const refused = new PaymentProviderError('format', 'FORMAT_ERROR', false, 400)

    it('cancels the payment, claims the order again, creates a new payment under a new key and signs it', async () => {
      const provider = fakeProvider({
        startSigning: vi
          .fn()
          .mockRejectedValueOnce(refused)
          .mockResolvedValueOnce({ providerAuthorisationId: 'auth-2', method: 'qr', state: 'pending', challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.new', qrImage: null, redirectUrl: null }, failureCode: null }),
      })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_events', { data: [{ payment_order_id: 'o1' }] }) // the cancel just confirmed
      db.setTable('payment_order_batches', [
        { data: signedOnce }, // restart loads the signing
        { data: signedOnce }, // what still waits
        { data: signedOnce }, // beginSca
        { data: signedOnce }, // stopSigning reads the signing
        { data: null }, // -> failed
        { data: fresh }, // beginSca on the new signing
        { data: { ...fresh, status: 'awaiting_signature', provider_authorisation_id: 'auth-2' } },
        { data: { ...fresh, status: 'awaiting_signature', provider_authorisation_id: 'auth-2' } },
      ])
      db.setTable('payment_orders', [
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] }, // stopSigning
        { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } }, // cancelAndRelease reads it again
        { data: [{ id: 'o1' }] }, // new create started
        { data: [{ id: 'o1' }] }, // new id stored
        { data: [waitingOrder('o1', 2, { batch_id: 'batch-2' })] }, // beginSca on the new signing
        { data: null }, // -> awaiting_signature
        { data: [waitingOrder('o1', 2, { batch_id: 'batch-2', status: 'awaiting_signature' })] },
      ])
      db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: true, batch: signedOnce, orders: [waitingOrder('o1', 1)] } })
      db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: fresh, orders: [claimedOrder('o1', { batch_id: 'batch-2' })] } })

      const result = await restart()

      expect(result).toMatchObject({ ok: true, data: { batch_id: 'batch-2', status: 'awaiting_signature', challenge: { qrData: 'bankid.qr.new' } } })
      // The expired payment is cancelled at the bank, confirmed, and its order released before anything new.
      expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
      expect(releases()).toEqual([expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: 'pay-1', p_reason: 'SIGNING_EXPIRED' })])
      expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([{ status: 'failed' }])
      // Claimed again, created again under the second key, signed on the new payment.
      expect(db.findCalls('rpc:claim_payment_orders_for_signing', 'rpc')).toEqual([[expect.objectContaining({ p_order_ids: ['o1'] })]])
      const instruction = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { endToEndId: string; attempt: number }
      expect(instruction).toMatchObject({ endToEndId: waitingOrder('o1', 1).end_to_end_id, attempt: 2 })
      expect(provider.startSigning).toHaveBeenLastCalledWith(expect.anything(), { kind: 'payment', providerPaymentId: 'pay-2', product: 'swedish-giro' }, 'qr', null)
      // The recreated payments live in a new signing: it keeps the number they were created with.
      expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: 'batch-2', companyId: COMPANY, personalNumber: '199001011239' })
      expect(events()).toContainEqual(
        expect.objectContaining({
          payment_order_id: 'o1',
          batch_id: 'batch-2',
          event_type: 'recreated_after_expired_signing',
          detail: { previous_batch_id: 'batch-1', previous_provider_payment_id: 'pay-1', provider_code: 'FORMAT_ERROR' },
        }),
      )
    })

    it('holds the order for a person when the bank does not confirm the cancel, and recreates nothing', async () => {
      const provider = fakeProvider({
        startSigning: vi.fn().mockRejectedValue(refused),
        cancelPayment: vi.fn().mockResolvedValue({ outcome: 'needs_authorisation', providerStatus: 'RCVD' }),
      })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', [{ data: signedOnce }, { data: signedOnce }, { data: signedOnce }, { data: signedOnce }, { data: null }])
      db.setTable('payment_orders', [
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } },
      ])
      db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: true, batch: signedOnce, orders: [waitingOrder('o1', 1)] } })

      const result = await restart()

      expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR', held_for_person: ['o1'], recreated: false } })
      expect(releases()).toEqual([])
      expect(db.findCalls('rpc:claim_payment_orders_for_signing', 'rpc')).toEqual([])
      expect(provider.createPayment).not.toHaveBeenCalled()
      expect(events()).toContainEqual(expect.objectContaining({ payment_order_id: 'o1', detail: expect.objectContaining({ code: 'BANK_CANCEL_NOT_CONFIRMED', reason: 'SIGNING_EXPIRED' }) }))
    })

    it('never recreates on a refusal of a first start, or on a refusal signing can never fix', async () => {
      // No earlier authorisation: a FORMAT_ERROR is the plain refusal it always was.
      const first = fakeProvider({ startSigning: vi.fn().mockRejectedValue(refused) })
      registerPaymentInitiationProvider(first)
      const neverSigned = batch({ signing_target: 'payment', order_count: 1 })
      db.setTable('payment_order_batches', { data: neverSigned })
      db.setTable('payment_orders', { data: [waitingOrder('o1', 1)] })
      db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: true, batch: neverSigned, orders: [waitingOrder('o1', 1)] } })

      expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR' } })
      expect(first.cancelPayment).not.toHaveBeenCalled()
      expect(first.createPayment).not.toHaveBeenCalled()

      // Signed before, but the person lacks the rights: stopped for good, never made anew.
      resetPaymentInitiationProviders()
      const rights = fakeProvider({ startSigning: vi.fn().mockRejectedValue(new PaymentProviderError('rights', 'PSU_RIGHTS_MISSING', false, 400)) })
      registerPaymentInitiationProvider(rights)
      db.setTable('payment_order_batches', [{ data: signedOnce }, { data: signedOnce }, { data: signedOnce }, { data: signedOnce }, { data: null }])
      db.setTable('payment_orders', [
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: [waitingOrder('o1', 1)] },
        { data: { id: 'o1', status: 'submitted', outcome_unknown_at: null } },
      ])
      db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: true, same: true, batch: signedOnce, orders: [waitingOrder('o1', 1)] } })

      expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'PSU_RIGHTS_MISSING' } })
      expect(rights.cancelPayment).toHaveBeenCalledTimes(1)
      expect(rights.createPayment).not.toHaveBeenCalled()
      expect(db.findCalls('rpc:claim_payment_orders_for_signing', 'rpc')).toEqual([])
    })
  })

  it('refuses a signing that is still active, and one with nothing left to sign', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    db.setTable('payment_order_batches', { data: batch({ status: 'awaiting_signature' }) })
    db.setTable('payment_orders', { data: [waitingOrder('o1', 1)] })
    expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' })

    db.setTable('payment_order_batches', { data: batch({ status: 'failed' }) })
    db.setTable('payment_orders', { data: [claimedOrder('o1', { outcome_unknown_at: '2026-09-30T09:00:00Z' })] })
    expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_NOTHING_TO_SIGN' })
  })
})

describe('pollPaymentSigning', () => {
  const signing = batch({ status: 'awaiting_signature', provider_batch_id: 'basket-at-bank', provider_authorisation_id: 'auth-1', signing_method: 'qr', signer_user_id: USER })
  const inSigning = [waitingOrder('o1', 1, { status: 'awaiting_signature' }), waitingOrder('o2', 2, { status: 'awaiting_signature' })]

  it('returns fresh QR data to the person signing', async () => {
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.2', qrImage: null, redirectUrl: null }, failureCode: null }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', { data: inSigning })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result).toMatchObject({ ok: true, data: { challenge: { qrData: 'bankid.qr.2' } } })
    expect(provider.pollSigning).toHaveBeenCalledWith(expect.anything(), { kind: 'basket', providerBasketId: 'basket-at-bank' }, 'auth-1', 'qr')

    // With a kept PSU-ID the poll sends it, the person's IP and user agent along.
    mock.storedBatchPsu.mockResolvedValue(KEPT_PSU)
    await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })
    expect(mock.storedBatchPsu).toHaveBeenCalledWith('batch-1')
    expect(provider.pollSigning).toHaveBeenLastCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU, psuIpAddress: '203.0.113.10', psuUserAgent: 'UA' }), expect.anything(), 'auth-1', 'qr')
  })

  it('gives anyone else where the signing stands, never the QR, and does not drive it', async () => {
    const provider = fakeProvider({ pollSigning: vi.fn() })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: { ...signing, signer_user_id: 'someone-else' } })
    db.setTable('payment_orders', { data: inSigning })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result).toMatchObject({ ok: true, data: { challenge: null, status: 'awaiting_signature' } })
    expect(provider.pollSigning).not.toHaveBeenCalled()
  })

  it('lets an abandoned BankID be signed again, resetting only this attempt', async () => {
    registerPaymentInitiationProvider(fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'USER_CANCEL' }) }))
    db.setTable('payment_order_batches', [{ data: signing }, { data: [{ id: 'batch-1' }] }, { data: signing }])
    db.setTable('payment_orders', { data: inSigning })

    const abandoned = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(abandoned).toMatchObject({ ok: true, data: { failure_code: 'USER_CANCEL' } })
    expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([{ status: 'created' }])
    expect(db.findCalls('payment_order_batches', 'eq')).toContainEqual(['provider_authorisation_id', 'auth-1'])
    expect(orderPatches()).toContainEqual({ status: 'submitted' })
  })

  it('cancels the payments at the bank and releases the orders when the person lacks the rights', async () => {
    const provider = fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'PSU_RIGHTS_MISSING' }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', [
      { data: inSigning },
      { data: inSigning }, // stopSigning reads the signing again
      { data: { id: 'o1', status: 'awaiting_signature', outcome_unknown_at: null } },
      { data: null }, // o1 awaiting -> submitted
      { data: { id: 'o2', status: 'awaiting_signature', outcome_unknown_at: null } },
      { data: null },
      { data: inSigning },
    ])

    await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(provider.cancelPayment).toHaveBeenCalledTimes(2)
    expect(releases().map((r) => [r.p_order_id, r.p_provider_payment_id])).toEqual([['o1', 'pay-1'], ['o2', 'pay-2']])
    expect(orderPatches().some((p) => p.status === 'failed')).toBe(false)
  })

  it.each(['BANK_AGREEMENT_MISSING', 'PSU_OPEN_BANKING_RIGHTS_MISSING', 'PAYMENT_PRODUCT_AGREEMENT_MISSING', 'KYC_INVALID', 'BANKID_EXTENDED_USE_REQUIRED', 'AMOUNT_LIMITATION_CONTROL_FAILED', 'PSU_CREDENTIALS_INVALID'])(
    'ends the signing for good on %s: the fix is in the online bank, so the payments are cancelled and the orders released',
    async (code) => {
      const provider = fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: code }) })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', { data: signing })
      db.setTable('payment_orders', [
        { data: inSigning },
        { data: inSigning },
        { data: { id: 'o1', status: 'awaiting_signature', outcome_unknown_at: null } },
        { data: null },
        { data: { id: 'o2', status: 'awaiting_signature', outcome_unknown_at: null } },
        { data: null },
        { data: inSigning },
      ])

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      expect(result).toMatchObject({ ok: true, data: { failure_code: code } })
      expect(provider.cancelPayment).toHaveBeenCalledTimes(2)
      expect(releases().map((r) => r.p_order_id)).toEqual(['o1', 'o2'])
      // Never reset to 'created' for another try: the batch ends failed.
      expect(db.findCalls('payment_order_batches', 'update')).not.toContainEqual([{ status: 'created' }])
    },
  )

  it('agrees with the browser on which failures are permanent', () => {
    expect([...PERMANENT_SIGNING_FAILURES].sort()).toEqual([...CLIENT_PERMANENT_SIGNING_FAILURES].sort())
  })

  it('never cancels a payment that moved on since the signing failed', async () => {
    const provider = fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'PSU_RIGHTS_MISSING' }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', [
      { data: inSigning },
      // Read again: o2 was signed in another session meanwhile.
      { data: [inSigning[0], waitingOrder('o2', 2, { status: 'accepted' })] },
      { data: null }, // o1 is no longer this payment in this signing
      { data: inSigning },
    ])

    await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(provider.cancelPayment).not.toHaveBeenCalled()
    expect(releases()).toEqual([])
  })

  it('applies each payment status after a finalised signing, a second signer included', async () => {
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'finalised', challenge: null, failureCode: null }),
      getPaymentState: vi
        .fn()
        .mockResolvedValueOnce({ providerStatus: 'ACSP', status: 'accepted', messages: [] })
        .mockResolvedValueOnce({ providerStatus: 'PATC', status: 'awaiting_second_signer', messages: ['AUTHORISATION_PENDING_API'] }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', [{ data: inSigning }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o2' }] }, { data: inSigning }])

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result.ok).toBe(true)
    expect(orderPatches().map((p) => p.status)).toEqual(['accepted', 'awaiting_second_signer'])
    const batchPatch = db.findCalls('payment_order_batches', 'update').map(([p]) => (p as { status?: string }).status)
    expect(batchPatch).toContain('awaiting_second_signer')
  })
})

describe('sanitizedProviderMessage', () => {
  it("keeps the provider's words, short, with account numbers and personnummer masked", () => {
    expect(sanitizedProviderMessage(new PaymentProviderError('Creditor account 5050-1055 invalid for 19900101-1239', 'FORMAT_ERROR', false))).toBe(
      'Creditor account *** invalid for ***',
    )
    expect(sanitizedProviderMessage(new PaymentProviderError('x'.repeat(500), 'FORMAT_ERROR', false))).toHaveLength(200)
  })

  it('keeps no text from anything that is not a provider failure', () => {
    expect(sanitizedProviderMessage(new Error('duplicate key value violates unique constraint "uq_payment_orders_end_to_end"'))).toBeNull()
    expect(sanitizedProviderMessage('boom')).toBeNull()
  })
})
