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

const mock = vi.hoisted(() => ({ supabase: null as unknown, storedBatchPsu: vi.fn(), rememberBatchPsu: vi.fn(), readMonth: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
// The month's sent payments and cap (usage.ts), answered here so the queued
// payment_orders answers below stay the signing's own; the cap's decision
// (allowance.ts) runs for real.
vi.mock('@/lib/payments/usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/usage')>()),
  readBankPaymentsMonth: (...a: unknown[]) => mock.readMonth(...a),
}))
vi.mock('@/lib/auth/resource-psu', () => ({
  storedBatchPsu: (...a: unknown[]) => mock.storedBatchPsu(...a),
  rememberBatchPsu: (...a: unknown[]) => mock.rememberBatchPsu(...a),
}))

import { FOLLOW_BANK_CONFIRMATION_MS, PERMANENT_SIGNING_FAILURES, pollPaymentSigning, restartPaymentSigning, startPaymentSigning, startSecondSignature } from '../signing'
import { PERMANENT_SIGNING_FAILURES as CLIENT_PERMANENT_SIGNING_FAILURES } from '@/components/payments/payment-order-status'

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }

beforeEach(() => {
  // The app origin these tests sign from is the canonical one: returns go to it directly (a brand host's would go through the hop).
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.accounted.se')
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
  mock.readMonth.mockReset().mockResolvedValue({ period: '2026-10', sent: [], included_payments: 10 })
})

/** The month as usage.ts reads it: `others` payments sent outside the signing, plus the signing's own ids already at the bank. */
function month(others: number, atBank: string[] = [], included = 10) {
  const sent = [...Array.from({ length: others }, (_, i) => ({ id: `sent-${i}`, cash_account_id: 'acct-1' })), ...atBank.map((id) => ({ id, cash_account_id: 'acct-1' }))]
  return { period: '2026-10', sent, included_payments: included }
}

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
    // The basket is made for this signing: a later signing over the same payments makes its own (crm#1282).
    expect(provider.createSigningBasket).toHaveBeenCalledWith(expect.anything(), ['pay-1', 'pay-2'], 'batch-1')
    expect(provider.startSigning).toHaveBeenCalledWith(
      expect.objectContaining({ signerPersonalNumber: '199001011239', debtorBic: 'ESSESESS', companyOrgNumber: '5566778899', accountContext: 'corporate', affiliatedAspspId: null }),
      { kind: 'basket', providerBasketId: 'basket-at-bank' },
      'qr',
      null,
    )
    const instruction = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(instruction).toMatchObject({ amount: 737.5, attempt: 1, payee: { type: 'bankgiro', bankgiro: '50501055' }, reference: { type: 'ocr', value: '4400112233' } })
    expect(db.supabase.rpc).toHaveBeenCalledWith('claim_payment_orders_for_signing', expect.objectContaining({ p_company_id: COMPANY, p_user_id: USER }))
    // The bank holds payments created with this PSU-ID: kept once for the signing, at its start (before
    // BankID, so the status sync can read a payment still awaiting signature) with the signer's IP address,
    // never read for new payments.
    expect(mock.rememberBatchPsu).toHaveBeenCalledTimes(1)
    expect(mock.rememberBatchPsu.mock.invocationCallOrder[0]).toBeLessThan((provider.startSigning as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!)
    expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: 'batch-1', companyId: COMPANY, personalNumber: '199001011239', ipAddress: '203.0.113.10' })
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

  // crm#1485: one open skattekonto order per execution day.
  it('refuses to move an approved skattekonto order onto a day that already has an open skattekonto payment, leaving it approved', async () => {
    const provider = fakeProvider({ createPayment: vi.fn() })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1', { purpose: 'skattekonto', supplier_invoice_id: null, requested_execution_date: '2026-10-09' })] }, // preview: a passed day
      { data: [{ id: 'o9', status: 'accepted', requested_execution_date: '2026-10-12' }] }, // the next banking day's open order
    ])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER, today: '2026-10-11' })

    expect(result).toMatchObject({
      ok: false,
      code: 'SKATTEKONTO_PAYMENT_DAY_TAKEN',
      details: { payment_order_id: 'o1', requested_execution_date: '2026-10-12', existing_payment_order_id: 'o9', existing_status: 'accepted' },
    })
    expect(orderPatches()).toHaveLength(0)
    expect(provider.createPayment).not.toHaveBeenCalled()
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
      expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: single.id, companyId: COMPANY, personalNumber: '199001011239', ipAddress: '203.0.113.10' })
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
      { data: [claimedOrder('o2', { status: 'failed' })] }, // the refused signing read back: o1 and o3 released
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
      { data: [waitingOrder('o1', 1), claimedOrder('o2', { status: 'failed' })] }, // the refused signing read back
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: [claimedOrder('o1'), claimedOrder('o2')] } })
    db.setTable('payment_order_batches', { data: batch() })

    await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })

    expect(releases()).toEqual([])
    expect(events()).toContainEqual(
      expect.objectContaining({ payment_order_id: 'o1', event_type: 'error', detail: expect.objectContaining({ code: 'BANK_CANCEL_NOT_CONFIRMED', answer }) }),
    )
  })

  it.each([
    ['carried a message, so the OCR is missing', 'message' as const, 'OCR_REF_REQUIRED'],
    ['carried an OCR, so that OCR is wrong', 'ocr' as const, 'OCR_REF_INVALID'],
  ])('reports a payee under hard OCR control by what the payment carried: it %s', async (_name, referenceType, expected) => {
    // Swedbank, 2026-10-26: a bankgiro under hard OCR control refused a payment referenced by invoice number.
    const provider = fakeProvider({ createPayment: vi.fn().mockRejectedValue(new PaymentProviderError('refused', 'OCR_REF_INVALID', false, 422)) })
    registerPaymentInitiationProvider(provider)
    const single = batch({ signing_target: 'payment', order_count: 1 })
    const refused = claimedOrder('o1', { reference_type: referenceType, status: 'failed' })
    db.setTable('payment_orders', [
      { data: [order('o1', { reference_type: referenceType })] }, // preview
      { data: [{ id: 'o1' }] }, // o1 marked
      { data: [{ id: 'o1' }] }, // o1 failed
      { data: [refused] }, // stopSigning reads the signing
      { data: [refused] }, // the refused signing read back
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single, orders: [claimedOrder('o1', { reference_type: referenceType })] } })
    db.setTable('payment_order_batches', { data: single })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: expected, payment_order_id: 'o1' } })
    expect(orderPatches()).toContainEqual(expect.objectContaining({ status: 'failed', provider_error_code: expected }))
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
      { data: [claimedOrder('o2', { outcome_unknown_at: '2026-09-30T08:01:00Z' })] }, // the refused signing read back: o1 released
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
      { data: [] }, // the refused signing read back: o1 released
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

  it('signs a skattekonto payment in one basket with a supplier payment: it has no invoice to check', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const tax = { purpose: 'skattekonto', supplier_invoice_id: null, payee_name: 'Skatteverket', payee_source: 'skatteverket', amount: 11000, reference: '1655446688087' } as const
    db.setTable('payment_orders', [
      { data: [order('o1'), order('t1', tax)] }, // preview
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 't1' }] },
      { data: [{ id: 't1' }] },
      { data: [waitingOrder('o1', 1), waitingOrder('t1', 2, tax)] }, // beginSca: still waiting
      { data: null },
      { data: [waitingOrder('o1', 1, { status: 'awaiting_signature' }), waitingOrder('t1', 2, { ...tax, status: 'awaiting_signature' })] },
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: [claimedOrder('o1'), claimedOrder('t1', tax)] } })
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank', status: 'awaiting_signature', provider_authorisation_id: 'auth-1' }) },
      { data: batch({ status: 'awaiting_signature' }) },
    ])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 't1'], method: 'qr', signer: SIGNER })

    expect(result.ok).toBe(true)
    expect(provider.startSigning).toHaveBeenCalledTimes(1)
    const instructions = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1])
    expect(instructions[1]).toMatchObject({
      amount: 11000,
      payee: { type: 'bankgiro', bankgiro: '50501055', name: 'Skatteverket' },
      reference: { type: 'ocr', value: '1655446688087' },
    })
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

describe('a refused start says where it left the payments (crm#1357)', () => {
  const single = () => batch({ signing_target: 'payment', order_count: 1, total_amount: 737.5 })
  const timedOut = () => new PaymentProviderError('The answer was lost', 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN', false, 502, true)

  it("carries the signing when the bank's create timed out: the order is held, and the same start could only be refused again", async () => {
    // Production, 2026-10-21: one payment signed from a phone; the bank did not answer the create within Connect's 20 s.
    const provider = fakeProvider({ createPayment: vi.fn().mockRejectedValue(timedOut()) })
    registerPaymentInitiationProvider(provider)
    const held = claimedOrder('o1', { outcome_unknown_at: '2026-10-21T04:35:46Z', provider_error_code: 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN' })
    db.setTable('payment_orders', [
      { data: [order('o1')] }, // preview
      { data: [{ id: 'o1' }] }, // create started
      { data: [{ id: 'o1' }] }, // held as outcome unknown
      { data: [held] }, // stopSigning, then the refused signing read back
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single(), orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', [{ data: single() }, { data: { ...single(), status: 'failed' } }])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({
      ok: false,
      code: 'PAYMENT_ORDERS_OUTCOME_UNKNOWN',
      details: {
        payment_order_id: 'o1',
        signing: {
          batch_id: 'batch-1',
          status: 'failed',
          challenge: null,
          failure_code: 'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN',
          orders: [{ id: 'o1', status: 'submitted', outcome_unknown: true }],
        },
      },
    })
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('carries the signing still waiting at the bank when BankID did not start, so it is signed again, not started anew', async () => {
    const provider = fakeProvider({
      startSigning: vi.fn().mockRejectedValue(new PaymentProviderError('busy', 'CONNECTOR_PAYMENTS_PROVIDER_FAILED', true, 503)),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o1' }] }, { data: [waitingOrder('o1', 1)] }])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single(), orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single() })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({
      ok: false,
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      details: {
        provider_code: 'CONNECTOR_PAYMENTS_PROVIDER_FAILED',
        signing: { batch_id: 'batch-1', status: 'created', failure_code: 'CONNECTOR_PAYMENTS_PROVIDER_FAILED', orders: [{ id: 'o1', status: 'submitted', outcome_unknown: false }] },
      },
    })
    expect(provider.cancelPayment).not.toHaveBeenCalled()
  })

  it('carries nothing when every order went back to approved: the same start may be tried again', async () => {
    const provider = fakeProvider({ createPayment: vi.fn().mockRejectedValue(new PaymentProviderError('busy', 'RATE_LIMITED', true, 429)) })
    registerPaymentInitiationProvider(provider)
    // A released order leaves the signing: reading it back finds none.
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }, { data: [] }])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single(), orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', [{ data: single() }, { data: { ...single(), status: 'failed' } }])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
    if (result.ok) throw new Error('unexpected')
    expect(result.details).not.toHaveProperty('signing')
    expect(releases()).toEqual([expect.objectContaining({ p_order_id: 'o1', p_reason: 'CREATE_NOT_SENT' })])
  })

  it('carries nothing when the signing cannot be read back: the refusal stands as it was', async () => {
    const provider = fakeProvider({ createPayment: vi.fn().mockRejectedValue(timedOut()) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [
      { data: [order('o1')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o1' }] },
      { data: [claimedOrder('o1', { outcome_unknown_at: '2026-10-21T04:35:46Z' })] }, // stopSigning
      { error: { message: 'connection reset' } }, // the refused signing read back
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: single(), orders: [claimedOrder('o1')] } })
    db.setTable('payment_order_batches', { data: single() })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_OUTCOME_UNKNOWN', details: { payment_order_id: 'o1' } })
    if (result.ok) throw new Error('unexpected')
    expect(result.details).not.toHaveProperty('signing')
    expect(log.warn).toHaveBeenCalledWith('refused signing could not be read back', expect.objectContaining({ batchId: 'batch-1' }))
  })
})

describe('the monthly cap on bank payments', () => {
  const start = () => startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })
  const restart = () => restartPaymentSigning(ctx, { batchId: 'batch-1', method: 'qr', signer: SIGNER })

  it.each([
    ['under the cap', 5],
    ['landing exactly on the cap', 8],
  ])('starts a signing %s', async (_name, others) => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    mock.readMonth.mockResolvedValue(month(others))
    db.setTable('payment_orders', { data: [order('o1'), order('o2')] })
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: false, code: 'not_approved' } })

    // Past the cap: the claim was reached (and refused by the fixture).
    expect(await start()).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
    expect(db.supabase.rpc).toHaveBeenCalledWith('claim_payment_orders_for_signing', expect.anything())
    expect(mock.readMonth).toHaveBeenCalledWith(db.supabase, COMPANY, expect.stringMatching(/^\d{4}-\d{2}$/))
  })

  it('refuses a signing over the cap before anything moves or reaches the bank', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    mock.readMonth.mockResolvedValue(month(9))
    db.setTable('payment_orders', { data: [order('o1', { requested_execution_date: '2026-10-11' }), order('o2')] })

    const result = await start()

    expect(result).toEqual({
      ok: false,
      code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED',
      details: { period: '2026-10', used: 9, included: 10, remaining: 1, requested: 2 },
      messageSv: 'Ni har använt 9 av 10 betalningar som ingår i oktober. Välj högst 1 betalning, eller begär fler under Inställningar, Kopplingar, Betalningar via banken.',
    })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(provider.getBankCapabilities).not.toHaveBeenCalled()
    expect(provider.createPayment).not.toHaveBeenCalled()
    // Not even the re-attest of a weekend date ran.
    expect(orderPatches()).toEqual([])
  })

  it('follows a raised allowance', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    mock.readMonth.mockResolvedValue(month(30, [], 40))
    db.setTable('payment_orders', { data: [order('o1'), order('o2')] })
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: false, code: 'not_approved' } })
    expect(await start()).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_WRONG_STATUS' })
  })

  it.each([
    ['under the cap', 3],
    ['landing exactly on the cap', 8],
  ])('signs again what waits at the bank %s, counting the waiting payments once', async (_name, others) => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const same = batch({ provider_batch_id: 'basket-old' })
    const both = [waitingOrder('o1', 1), waitingOrder('o2', 2)]
    // o1 and o2 reached the bank this month: they are in the month's count already.
    mock.readMonth.mockResolvedValue(month(others, ['o1', 'o2']))
    db.setTable('payment_order_batches', { data: same })
    db.setTable('payment_orders', { data: both })
    db.setTable('rpc:rebatch_payment_orders_for_signing', { data: { ok: false, code: 'ineligible', details: [{ id: 'o2', reason: 'not_payable' }] } })

    // Past the cap: the rebatch was reached (and refused by the fixture).
    expect(await restart()).toMatchObject({ ok: false, code: 'PAYMENT_ORDERS_INELIGIBLE' })
    expect(db.supabase.rpc).toHaveBeenCalledWith('rebatch_payment_orders_for_signing', expect.anything())
  })

  it('refuses to sign again when the month is already past the cap, before the bank is asked anything', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const same = batch({ provider_batch_id: 'basket-old' })
    mock.readMonth.mockResolvedValue(month(9, ['o1', 'o2']))
    db.setTable('payment_order_batches', { data: same })
    db.setTable('payment_orders', { data: [waitingOrder('o1', 1), waitingOrder('o2', 2)] })

    expect(await restart()).toMatchObject({
      ok: false,
      code: 'BANK_PAYMENTS_ALLOWANCE_EXCEEDED',
      details: { period: '2026-10', used: 9, included: 10, remaining: 1, requested: 2 },
    })
    expect(db.supabase.rpc).not.toHaveBeenCalled()
    expect(provider.getBankCapabilities).not.toHaveBeenCalled()
    expect(provider.getPaymentState).not.toHaveBeenCalled()
    expect(provider.startSigning).not.toHaveBeenCalled()
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
    expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: 'batch-2', companyId: COMPANY, personalNumber: KEPT_PSU, ipAddress: '203.0.113.10' })
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
      expect(mock.rememberBatchPsu).toHaveBeenCalledWith({ batchId: 'batch-2', companyId: COMPANY, personalNumber: '199001011239', ipAddress: '203.0.113.10' })
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

    it("reads the bank's refusal when the adapter throws it from another copy of the port, as in production (crm#1282)", async () => {
      // lib/init builds the adapter in the instrumentation hook's copy of the
      // port; this test's signing module holds another one.
      vi.resetModules()
      const instrumentation = await import('@/lib/payments/initiation/provider')
      expect(instrumentation.PaymentProviderError).not.toBe(PaymentProviderError)
      const provider = fakeProvider({
        startSigning: vi.fn().mockRejectedValue(new instrumentation.PaymentProviderError('format', 'FORMAT_ERROR', false, 422)),
        cancelPayment: vi.fn().mockResolvedValue({ outcome: 'too_late', providerStatus: 'RCVD', unsigned: true }),
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

      // The bank's own code, not UNEXPECTED_ERROR, and the recreate was tried: the payment is cancelled first.
      expect(result).toMatchObject({ ok: false, details: { provider_code: 'FORMAT_ERROR', http_status: 422, held_for_person: ['o1'], recreated: false } })
      expect(provider.cancelPayment).toHaveBeenCalledWith(expect.anything(), 'pay-1', 'swedish-giro')
      expect(log.warn).toHaveBeenCalledWith('payment signing did not start', expect.objectContaining({ code: 'FORMAT_ERROR' }))
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

  it("never answers a signing on the bank's own page with a link-less challenge, so the start's link stays on screen (crm#1282)", async () => {
    // The provider repeats the approach on every poll of a redirect signing, without the link the start minted.
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: { approach: 'redirect', autostartToken: null, qrData: null, qrImage: null, redirectUrl: null }, failureCode: null }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: { ...signing, signing_method: 'redirect' } })
    db.setTable('payment_orders', { data: inSigning })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result).toMatchObject({ ok: true, data: { status: 'awaiting_signature', challenge: null, failure_code: null } })
    expect(provider.pollSigning).toHaveBeenCalledWith(expect.anything(), { kind: 'basket', providerBasketId: 'basket-at-bank' }, 'auth-1', 'redirect')
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

  describe('a payment the bank confirms after the rest of the signing (crm desk #1267)', () => {
    const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString()
    const signed = (signedAt: string) => batch({ ...signing, status: 'signed', signed_at: signedAt })
    const acceptedO1 = waitingOrder('o1', 1, { status: 'accepted', provider_status: 'ACSP' })
    const lateO2 = waitingOrder('o2', 2, { status: 'awaiting_signature', provider_status: 'RCVD' })

    it('reports a payment still RCVD after a finalised BankID as the bank confirming it, not as waiting for a signature, and keeps following it', async () => {
      const provider = fakeProvider({
        pollSigning: vi.fn().mockResolvedValue({ state: 'finalised', challenge: null, failureCode: null }),
        getPaymentState: vi
          .fn()
          .mockResolvedValueOnce({ providerStatus: 'ACSP', status: 'accepted', messages: [] })
          .mockResolvedValueOnce({ providerStatus: 'RCVD', status: 'submitted', messages: [] }),
      })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', [{ data: signing }, { data: null }, { data: signed(secondsAgo(0)) }])
      db.setTable('payment_orders', [{ data: inSigning }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o2' }] }, { data: [acceptedO1, lateO2] }])

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      if (!result.ok || result.dryRun) throw new Error('unexpected')
      expect(result.data.status).toBe('signed')
      expect(result.data.follow_up).toBe(true)
      expect(result.data.orders).toEqual([
        expect.objectContaining({ id: 'o1', status: 'accepted', bank_confirming: false }),
        expect.objectContaining({ id: 'o2', status: 'awaiting_signature', bank_confirming: true }),
      ])
      // RCVD moved nothing: o2 only had its provider status written.
      expect(orderPatches().map((p) => p.status)).toEqual(['accepted', undefined])
      expect(orderPatches()[1]).toMatchObject({ provider_status: 'RCVD' })
    })

    it('reads that payment again on the next poll, and stops following once the bank accepted it', async () => {
      const provider = fakeProvider({
        pollSigning: vi.fn(),
        getPaymentState: vi.fn().mockResolvedValue({ providerStatus: 'ACSP', status: 'accepted', messages: [] }),
      })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', { data: signed(secondsAgo(30)) })
      db.setTable('payment_orders', [
        { data: [acceptedO1, lateO2] },
        { data: [{ id: 'o2' }] },
        { data: [acceptedO1, waitingOrder('o2', 2, { status: 'accepted', provider_status: 'ACSP' })] },
      ])

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      if (!result.ok || result.dryRun) throw new Error('unexpected')
      // The BankID is over: only the late payment is read, the signing is not polled.
      expect(provider.pollSigning).not.toHaveBeenCalled()
      expect(provider.getPaymentState).toHaveBeenCalledTimes(1)
      expect(provider.getPaymentState).toHaveBeenCalledWith(expect.anything(), 'pay-2', 'swedish-giro')
      expect(orderPatches()).toEqual([expect.objectContaining({ status: 'accepted', provider_status: 'ACSP' })])
      expect(db.findCalls('payment_orders', 'eq')).toContainEqual(['status', 'awaiting_signature'])
      expect(result.data.follow_up).toBe(false)
      expect(result.data.orders.every((o) => !o.bank_confirming)).toBe(true)
    })

    it('stops following when the bank executed it', async () => {
      registerPaymentInitiationProvider(fakeProvider({ getPaymentState: vi.fn().mockResolvedValue({ providerStatus: 'ACSC', status: 'executed', messages: [] }) }))
      db.setTable('payment_order_batches', { data: signed(secondsAgo(60)) })
      db.setTable('payment_orders', [
        { data: [acceptedO1, lateO2] },
        { data: [{ id: 'o2' }] },
        { data: [acceptedO1, waitingOrder('o2', 2, { status: 'executed', provider_status: 'ACSC' })] },
      ])

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      if (!result.ok || result.dryRun) throw new Error('unexpected')
      expect(orderPatches()).toEqual([expect.objectContaining({ status: 'executed' })])
      expect(result.data.follow_up).toBe(false)
    })

    it('keeps following while the bank still answers RCVD, never moving the order back', async () => {
      const provider = fakeProvider({ getPaymentState: vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }) })
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', { data: signed(secondsAgo(90)) })
      db.setTable('payment_orders', [{ data: [acceptedO1, lateO2] }, { data: [{ id: 'o2' }] }, { data: [acceptedO1, lateO2] }])

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      if (!result.ok || result.dryRun) throw new Error('unexpected')
      expect(orderPatches()).toHaveLength(1)
      expect(orderPatches()[0]!.status).toBeUndefined()
      expect(events()).toEqual([])
      expect(result.data.follow_up).toBe(true)
      expect(result.data.orders[1]).toMatchObject({ status: 'awaiting_signature', bank_confirming: true })
    })

    it('hands the payment to the status sync once the follow-up window is over', async () => {
      const provider = fakeProvider()
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', { data: signed(new Date(Date.now() - FOLLOW_BANK_CONFIRMATION_MS - 1000).toISOString()) })
      db.setTable('payment_orders', { data: [acceptedO1, lateO2] })

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      if (!result.ok || result.dryRun) throw new Error('unexpected')
      expect(provider.getPaymentState).not.toHaveBeenCalled()
      expect(orderPatches()).toEqual([])
      expect(result.data.follow_up).toBe(false)
      // Still signed and still confirming at the bank: never shown as waiting for a signature.
      expect(result.data.orders[1]).toMatchObject({ status: 'awaiting_signature', bank_confirming: true })
    })

    it('reads nothing for anyone but the person who signed', async () => {
      const provider = fakeProvider()
      registerPaymentInitiationProvider(provider)
      db.setTable('payment_order_batches', { data: { ...signed(secondsAgo(10)), signer_user_id: 'someone-else' } })
      db.setTable('payment_orders', { data: [acceptedO1, lateO2] })

      const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

      if (!result.ok || result.dryRun) throw new Error('unexpected')
      expect(provider.getPaymentState).not.toHaveBeenCalled()
      expect(result.data).toMatchObject({ follow_up: false })
      expect(result.data.orders[1]).toMatchObject({ bank_confirming: true })
    })
  })
})

// SEB (Open Payments' answer, 2026-10-28): the first BankID of a basket
// finalises within seconds without a signature and leaves the payments PATC
// with AUTHORISATION_PENDING_API; the other signatory signs the same basket
// through a new authorisation under their own PSU-ID. Production, 20 Oct: a
// basket of two whose first BankID finalised in 1.98 s; nobody could give the
// second signature and SEB rejected the payments on the pay date.
describe('the second signature at a bank that takes it through the API', () => {
  /** The other signatory, typed in the dialog. */
  const SECOND = { personalNumber: '19850505-1238', ipAddress: '203.0.113.20', userAgent: 'UA2' }
  /** The move to awaiting_second_signer as applyProviderState records it when the adapter read the API from the bank. */
  const RECORDED = { messages: ['AUTHORISATION_PENDING_API'], second_signature_via_api: true }
  const recordedFor = (...ids: string[]) => ({ data: ids.map((id) => ({ payment_order_id: id, detail: RECORDED })) })
  const waiting = batch({
    status: 'awaiting_second_signer',
    provider_batch_id: 'basket-at-bank',
    provider_authorisation_id: 'auth-1',
    signing_method: 'qr',
    signer_user_id: USER,
    signing_started_at: '2026-10-20T12:39:00Z',
    signed_at: '2026-10-20T12:39:02Z',
  })
  /** The second signature started after the first BankID finalised. */
  const secondOpen = { ...waiting, provider_authorisation_id: 'auth-2', signing_started_at: '2026-10-20T12:45:00Z' }
  const patc = [
    waitingOrder('o1', 1, { status: 'awaiting_second_signer', provider_status: 'PATC' }),
    waitingOrder('o2', 2, { status: 'awaiting_second_signer', provider_status: 'PATC' }),
  ]
  const accepted = patc.map((o) => ({ ...o, status: 'accepted' as const, provider_status: 'ACTC' }))
  /** The adapter's answer for SEB's PATC (connect.ts maps the message). */
  const PATC_API = { providerStatus: 'PATC', status: 'awaiting_second_signer' as const, messages: ['AUTHORISATION_PENDING_API'], secondSignatureViaApi: true }
  const ACTC = { providerStatus: 'ACTC', status: 'accepted' as const, messages: [] }
  const second = () => startSecondSignature(ctx, { batchId: 'batch-1', method: 'qr', signer: SECOND })
  const batchPatches = () => db.findCalls('payment_order_batches', 'update').map(([patch]) => patch as Record<string, unknown>)

  beforeEach(() => {
    // The payments were created with the first signatory's number, and the bank said the API for both.
    mock.storedBatchPsu.mockResolvedValue(KEPT_PSU)
    db.setTable('payment_order_events', recordedFor('o1', 'o2'))
  })

  it("starts a new authorisation on the same basket under the other signatory's PSU-ID, creating and cancelling nothing", async () => {
    const provider = fakeProvider({
      getPaymentState: vi.fn().mockResolvedValue(PATC_API),
      startSigning: vi.fn().mockResolvedValue({
        providerAuthorisationId: 'auth-2',
        method: 'qr',
        state: 'pending',
        challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.second', qrImage: null, redirectUrl: null },
        failureCode: null,
      }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', [{ data: waiting }, { data: waiting }, { data: secondOpen }])
    db.setTable('payment_orders', [{ data: patc }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o2' }] }, { data: patc }])

    const result = await second()

    // The screen follows it as a signing in progress, with the other signatory's challenge.
    expect(result).toMatchObject({ ok: true, data: { batch_id: 'batch-1', status: 'awaiting_signature', challenge: { qrData: 'bankid.qr.second' } } })
    expect(provider.startSigning).toHaveBeenCalledWith(
      expect.objectContaining({ signerPersonalNumber: '198505051238', psuIpAddress: '203.0.113.20' }),
      { kind: 'basket', providerBasketId: 'basket-at-bank' },
      'qr',
      null,
    )
    // Each payment was read first, with the PSU-ID it was created with.
    expect(provider.getPaymentState).toHaveBeenCalledTimes(2)
    expect(provider.getPaymentState).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU }), 'pay-1', 'swedish-giro')
    // The batch stays awaiting_second_signer and names this attempt, against the one it replaced.
    expect(batchPatches()).toEqual([expect.objectContaining({ provider_authorisation_id: 'auth-2', signing_method: 'qr', signer_user_id: USER, signing_started_at: expect.any(String) })])
    expect(batchPatches()[0]).not.toHaveProperty('status')
    expect(db.findCalls('payment_order_batches', 'eq')).toEqual(expect.arrayContaining([['status', 'awaiting_second_signer'], ['provider_authorisation_id', 'auth-1']]))
    expect(events()).toContainEqual(expect.objectContaining({ event_type: 'signing_started', batch_id: 'batch-1', detail: { method: 'qr', second_signature: true } }))
    // Nothing at the bank is made or undone, and the payments keep the first PSU-ID.
    expect(provider.createPayment).not.toHaveBeenCalled()
    expect(provider.createSigningBasket).not.toHaveBeenCalled()
    expect(provider.cancelPayment).not.toHaveBeenCalled()
    expect(mock.rememberBatchPsu).not.toHaveBeenCalled()
  })

  it('refuses the number the first signature was made with: the bank waits for another person', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: waiting })
    db.setTable('payment_orders', { data: patc })

    const result = await startSecondSignature(ctx, { batchId: 'batch-1', method: 'qr', signer: { ...SECOND, personalNumber: '19800101-9879' } })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_SECOND_SIGNER_SAME_PERSON' })
    expect(provider.getPaymentState).not.toHaveBeenCalled()
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('refuses where the bank takes the second signature in its online bank, before asking the bank anything', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: waiting })
    db.setTable('payment_orders', { data: patc })
    db.setTable('payment_order_events', recordedFor('o1'))

    expect(await second()).toMatchObject({ ok: false, code: 'PAYMENT_SECOND_SIGNATURE_IN_ONLINE_BANK' })
    expect(provider.getPaymentState).not.toHaveBeenCalled()
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('refuses a signing that does not wait for another signatory', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: batch({ status: 'awaiting_signature', provider_batch_id: 'basket-at-bank' }) })
    db.setTable('payment_orders', { data: patc })

    expect(await second()).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_NOT_ACTIVE' })
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it('leaves the payments and the first signature where they were when the bank refuses the start', async () => {
    const provider = fakeProvider({
      getPaymentState: vi.fn().mockResolvedValue(PATC_API),
      startSigning: vi.fn().mockRejectedValue(new PaymentProviderError('No rights', 'PSU_RIGHTS_MISSING', false, 403)),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', [{ data: waiting }, { data: waiting }])
    db.setTable('payment_orders', [{ data: patc }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o2' }] }, { data: patc }])

    const result = await second()

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'PSU_RIGHTS_MISSING' } })
    // A permanent code stops a first signing; here the first signature stands and someone else may sign.
    expect(provider.cancelPayment).not.toHaveBeenCalled()
    expect(releases()).toEqual([])
    expect(batchPatches()).toEqual([])
  })

  it('ends the signing without a BankID when the payments were signed in the online bank meanwhile', async () => {
    const provider = fakeProvider({ getPaymentState: vi.fn().mockResolvedValue(ACTC) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', [{ data: waiting }, { data: waiting }, { data: null }, { data: { ...waiting, status: 'signed' } }])
    db.setTable('payment_orders', [{ data: patc }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o2' }] }, { data: accepted }, { data: accepted }])

    const result = await second()

    expect(result).toMatchObject({ ok: true, data: { status: 'signed' } })
    expect(orderPatches().map((p) => p.status)).toEqual(['accepted', 'accepted'])
    expect(batchPatches()).toEqual([expect.objectContaining({ status: 'signed' })])
    expect(provider.startSigning).not.toHaveBeenCalled()
  })

  it("polls the second signature with the other signatory's number, and shows it as a signing in progress", async () => {
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.3', qrImage: null, redirectUrl: null }, failureCode: null }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: secondOpen })
    db.setTable('payment_orders', { data: patc })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SECOND })

    expect(result).toMatchObject({ ok: true, data: { status: 'awaiting_signature', challenge: { qrData: 'bankid.qr.3' } } })
    expect(provider.pollSigning).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: '198505051238' }), { kind: 'basket', providerBasketId: 'basket-at-bank' }, 'auth-2', 'qr')
  })

  it('reads each payment once the second signature finalised and ends the signing signed', async () => {
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'finalised', challenge: null, failureCode: null }),
      getPaymentState: vi.fn().mockResolvedValue(ACTC),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', [{ data: secondOpen }, { data: null }, { data: { ...secondOpen, status: 'signed' } }])
    db.setTable('payment_orders', [{ data: patc }, { data: [{ id: 'o1' }] }, { data: [{ id: 'o2' }] }, { data: accepted }])

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SECOND })

    expect(result).toMatchObject({ ok: true, data: { status: 'signed', second_signature_here: false } })
    expect(provider.getPaymentState).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU }), 'pay-2', 'swedish-giro')
    expect(orderPatches().map((p) => p.status)).toEqual(['accepted', 'accepted'])
    expect(batchPatches()).toEqual([expect.objectContaining({ status: 'signed', signed_at: expect.any(String) })])
    expect(db.findCalls('payment_order_batches', 'eq')).toContainEqual(['provider_authorisation_id', 'auth-2'])
  })

  it('leaves the payments and the first signature where they were when the second BankID is cancelled, and ends only that attempt', async () => {
    const provider = fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'USER_CANCEL' }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', [{ data: secondOpen }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', { data: patc })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SECOND })

    expect(result).toMatchObject({ ok: true, data: { status: 'awaiting_second_signer', failure_code: 'USER_CANCEL', second_signature_here: true } })
    // No BankID runs any more: the attempt is closed, its batch still waits for the other signatory.
    expect(batchPatches()).toEqual([{ signing_started_at: null }])
    expect(db.findCalls('payment_order_batches', 'eq')).toEqual(expect.arrayContaining([['status', 'awaiting_second_signer'], ['provider_authorisation_id', 'auth-2']]))
    expect(orderPatches()).toEqual([])
    expect(provider.cancelPayment).not.toHaveBeenCalled()
    expect(events().filter((e) => e.event_type === 'error')).toEqual([expect.objectContaining({ detail: { code: 'USER_CANCEL', stage: 'second_signature' } })])

    // A later poll of the closed attempt asks the bank nothing and logs nothing.
    db.setTable('payment_order_batches', { data: { ...secondOpen, signing_started_at: null } })
    const later = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SECOND })
    expect(later).toMatchObject({ ok: true, data: { status: 'awaiting_second_signer', failure_code: null } })
    expect(provider.pollSigning).toHaveBeenCalledTimes(1)
    expect(events().filter((e) => e.event_type === 'error')).toHaveLength(1)
  })

  it("says after the first BankID that the other signatory signs here, from the bank's message", async () => {
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'finalised', challenge: null, failureCode: null }),
      getPaymentState: vi.fn().mockResolvedValue(PATC_API),
    })
    registerPaymentInitiationProvider(provider)
    const first = { ...waiting, status: 'awaiting_signature' as const, signed_at: null }
    db.setTable('payment_order_batches', [{ data: first }, { data: null }, { data: waiting }])
    db.setTable('payment_orders', [
      { data: patc.map((o) => ({ ...o, status: 'awaiting_signature' as const, provider_status: 'RCVD' })) },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: patc },
    ])

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result).toMatchObject({ ok: true, data: { status: 'awaiting_second_signer', second_signature_here: true } })
    // The move to awaiting_second_signer keeps the bank's message: the record the signal is read from.
    expect(events()).toContainEqual(expect.objectContaining({ event_type: 'status_changed', to_status: 'awaiting_second_signer', detail: RECORDED }))
    expect(db.findCalls('payment_order_events', 'eq')).toEqual(expect.arrayContaining([['to_status', 'awaiting_second_signer'], ['event_type', 'status_changed']]))
  })

  it('names the online bank when the bank did not say the API, and asks nothing at the bank until a second signature starts', async () => {
    const provider = fakeProvider({ pollSigning: vi.fn() })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: waiting })
    db.setTable('payment_orders', { data: patc })
    db.setTable('payment_order_events', { data: [{ payment_order_id: 'o1', detail: { messages: ['SOMETHING_ELSE'] } }] })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result).toMatchObject({ ok: true, data: { status: 'awaiting_second_signer', second_signature_here: false } })
    expect(provider.pollSigning).not.toHaveBeenCalled()
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
