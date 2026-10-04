import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  PaymentProviderError,
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'
import type { PaymentOrderBatchRow, PaymentOrderRow } from '../types'

const mock = vi.hoisted(() => ({ supabase: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))

import { pollPaymentSigning, startPaymentSigning } from '../signing'

const COMPANY = 'company-1'
const USER = 'user-1'
const SIGNER = { personalNumber: '19900101-1239', ipAddress: '203.0.113.10', userAgent: 'UA' }

function order(id: string, overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id,
    company_id: COMPANY,
    user_id: USER,
    purpose: 'supplier_invoice',
    supplier_invoice_id: `inv-${id}`,
    batch_id: null,
    status: 'approved',
    amount: 737.5,
    currency: 'SEK',
    requested_execution_date: '2026-10-20',
    cash_account_id: 'acct-1',
    debtor_snapshot: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Konto', currency: 'SEK', bank_name: null },
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    payee_bic: null,
    payee_name: 'Derome Bygg AB',
    payee_source: 'supplier',
    payee_check: 'known',
    reference_type: 'ocr',
    reference: '4400112233',
    end_to_end_id: `ACC${id.padEnd(32, '0')}`,
    idempotency_key: `k-${id}`,
    provider: null,
    provider_payment_id: null,
    provider_payment_product: null,
    provider_status: null,
    provider_status_at: null,
    provider_error_code: null,
    provider_error_message: null,
    approved_by: USER,
    approved_at: '2026-09-30T08:00:00Z',
    submitted_by: null,
    submitted_at: null,
    signed_at: null,
    executed_at: null,
    cancelled_by: null,
    cancelled_at: null,
    matched_transaction_id: null,
    supplier_invoice_payment_id: null,
    matched_at: null,
    created_at: '2026-09-30T07:00:00Z',
    updated_at: '2026-09-30T07:00:00Z',
    ...overrides,
  }
}

function batch(overrides: Partial<PaymentOrderBatchRow> = {}): PaymentOrderBatchRow {
  return {
    id: 'batch-1',
    company_id: COMPANY,
    user_id: USER,
    provider: 'open_payments',
    signing_target: 'basket',
    provider_batch_id: null,
    status: 'created',
    provider_status: null,
    provider_status_at: null,
    provider_authorisation_id: null,
    signing_method: null,
    signer_user_id: null,
    signing_started_at: null,
    signed_at: null,
    order_count: 2,
    total_amount: 1475,
    currency: 'SEK',
    created_at: '2026-09-30T08:00:00Z',
    updated_at: '2026-09-30T08:00:00Z',
    ...overrides,
  }
}

function fakeProvider(overrides: Partial<PaymentInitiationProvider> = {}): PaymentInitiationProvider {
  let n = 0
  return {
    id: 'open_payments',
    isAvailableFor: () => true,
    getCompanyVerification: vi.fn().mockResolvedValue({ status: 'valid', validUntil: '2027-03-29' }),
    startCompanyVerification: vi.fn(),
    createPayment: vi.fn().mockImplementation(async () => {
      n += 1
      return { providerPaymentId: `pay-${n}`, product: 'swedish-giro', providerStatus: 'RCVD', status: 'submitted', messages: [] }
    }),
    createSigningBasket: vi.fn().mockResolvedValue({ providerBasketId: 'basket-at-bank' }),
    startSigning: vi.fn().mockResolvedValue({
      providerAuthorisationId: 'auth-1',
      method: 'qr',
      state: 'pending',
      challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.1', redirectUrl: null },
      failureCode: null,
    }),
    pollSigning: vi.fn(),
    getPaymentState: vi.fn(),
    cancelPayment: vi.fn(),
    ...overrides,
  }
}

let db: ReturnType<typeof createTableMockSupabase>
let ctx: OperationContext

beforeEach(() => {
  resetPaymentInitiationProviders()
  db = createTableMockSupabase({
    company_settings: { data: { org_number: '556677-8899' } },
    bankid_identities: { data: null },
    payment_order_events: { data: null },
  })
  mock.supabase = db.supabase
  ctx = {
    supabase: db.supabase as never,
    companyId: COMPANY,
    userId: USER,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  }
})

describe('startPaymentSigning', () => {
  it('creates each payment once, bundles them in a basket and starts BankID', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    const claimed = [order('o1', { status: 'submitted', batch_id: 'batch-1' }), order('o2', { status: 'submitted', batch_id: 'batch-1' })]
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] }, // preview
      { data: null }, // provider id o1
      { data: null }, // provider id o2
      { data: null }, // -> awaiting_signature
      { data: claimed.map((o) => ({ ...o, status: 'awaiting_signature' })) }, // reload
    ])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch(), orders: claimed } })
    db.setTable('payment_order_batches', [
      { data: batch({ provider_batch_id: 'basket-at-bank' }) },
      { data: batch({ provider_batch_id: 'basket-at-bank', status: 'awaiting_signature', provider_authorisation_id: 'auth-1' }) },
      { data: batch({ status: 'awaiting_signature' }) },
    ])

    const result = await startPaymentSigning(ctx, { orderIds: ['o1', 'o2'], method: 'qr', signer: SIGNER })

    expect(result.ok).toBe(true)
    if (!result.ok || result.dryRun) throw new Error('unexpected')
    expect(result.data.challenge?.qrData).toBe('bankid.qr.1')
    expect(provider.createPayment).toHaveBeenCalledTimes(2)
    expect(provider.createSigningBasket).toHaveBeenCalledWith(expect.anything(), ['pay-1', 'pay-2'])
    expect(provider.startSigning).toHaveBeenCalledWith(
      expect.objectContaining({ signerPersonalNumber: '199001011239', debtorBic: 'ESSESESS', companyOrgNumber: '556677-8899' }),
      { kind: 'basket', providerBasketId: 'basket-at-bank' },
      'qr',
    )
    const instruction = (provider.createPayment as ReturnType<typeof vi.fn>).mock.calls[0]![1]
    expect(instruction).toMatchObject({ amount: 737.5, payee: { type: 'bankgiro', bankgiro: '50501055' }, reference: { type: 'ocr', value: '4400112233' } })
  })

  it('checks the company verification before claiming anything', async () => {
    const provider = fakeProvider({ getCompanyVerification: vi.fn().mockResolvedValue({ status: 'invalid', validUntil: null }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', { data: [order('o1')] })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_COMPANY_VERIFICATION_REQUIRED' })
    expect(db.findCall('rpc:claim_payment_orders_for_signing', 'rpc')).toBeUndefined()
    expect(provider.createPayment).not.toHaveBeenCalled()
  })

  it('fails the signing instead of retrying when the bank refuses a payment', async () => {
    const provider = fakeProvider({
      createPayment: vi.fn().mockRejectedValue(new PaymentProviderError('refused', 'FORMAT_ERROR', false, 400)),
    })
    registerPaymentInitiationProvider(provider)
    const claimed = [order('o1', { status: 'submitted', batch_id: 'batch-1' })]
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }])
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch({ signing_target: 'payment', order_count: 1 }), orders: claimed } })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_PROVIDER_REFUSED', details: { provider_code: 'FORMAT_ERROR' } })
    expect(provider.createPayment).toHaveBeenCalledTimes(1)
    expect(provider.startSigning).not.toHaveBeenCalled()
    expect(db.findCalls('payment_orders', 'update').some(([patch]) => (patch as { status?: string }).status === 'failed')).toBe(true)
  })

  it('fails the orders with a clear answer when the bank only signs on its own page', async () => {
    const provider = fakeProvider({
      startSigning: vi.fn().mockRejectedValue(new PaymentProviderError('redirect only', 'SCA_REDIRECT_UNSUPPORTED', false)),
    })
    registerPaymentInitiationProvider(provider)
    const claimed = [order('o1', { status: 'submitted', batch_id: 'batch-1' })]
    db.setTable('payment_orders', [{ data: [order('o1')] }, { data: [{ id: 'o1' }] }])
    db.setTable('payment_order_batches', { data: batch({ signing_target: 'payment', order_count: 1 }) })
    db.setTable('rpc:claim_payment_orders_for_signing', { data: { ok: true, batch: batch({ signing_target: 'payment', order_count: 1 }), orders: claimed } })

    const result = await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })

    expect(result).toMatchObject({ ok: false, code: 'PAYMENT_SIGNING_REDIRECT_UNSUPPORTED', details: { provider_code: 'SCA_REDIRECT_UNSUPPORTED' } })
    const failed = db.findCalls('payment_orders', 'update').find(([patch]) => (patch as { status?: string }).status === 'failed')
    expect(failed?.[0]).toMatchObject({ status: 'failed', provider_error_code: 'SCA_REDIRECT_UNSUPPORTED' })
    expect(db.findCalls('payment_order_batches', 'update')).toContainEqual([{ status: 'failed' }])
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

  it('is unavailable without a registered provider', async () => {
    expect(await startPaymentSigning(ctx, { orderIds: ['o1'], method: 'qr', signer: SIGNER })).toMatchObject({ ok: false, code: 'PAYMENTS_UNAVAILABLE' })
  })
})

describe('pollPaymentSigning', () => {
  const signing = batch({ status: 'awaiting_signature', provider_batch_id: 'basket-at-bank', provider_authorisation_id: 'auth-1', signing_method: 'qr' })
  const inSigning = [
    order('o1', { status: 'awaiting_signature', batch_id: 'batch-1', provider_payment_id: 'pay-1', provider_payment_product: 'swedish-giro' }),
    order('o2', { status: 'awaiting_signature', batch_id: 'batch-1', provider_payment_id: 'pay-2', provider_payment_product: 'swedish-giro' }),
  ]

  it('returns fresh QR data while the person has not signed', async () => {
    const provider = fakeProvider({
      pollSigning: vi.fn().mockResolvedValue({ state: 'pending', challenge: { approach: 'decoupled', autostartToken: null, qrData: 'bankid.qr.2', redirectUrl: null }, failureCode: null }),
    })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', { data: inSigning })

    const result = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })

    expect(result).toMatchObject({ ok: true, data: { challenge: { qrData: 'bankid.qr.2' } } })
    expect(provider.pollSigning).toHaveBeenCalledWith(expect.anything(), { kind: 'basket', providerBasketId: 'basket-at-bank' }, 'auth-1', 'qr')
  })

  it('lets an abandoned BankID be signed again, but fails the orders when the person lacks the rights', async () => {
    registerPaymentInitiationProvider(fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'USER_CANCEL' }) }))
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', { data: inSigning })
    const abandoned = await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })
    expect(abandoned).toMatchObject({ ok: true, data: { failure_code: 'USER_CANCEL' } })
    expect(db.findCalls('payment_order_batches', 'update').some(([p]) => (p as { status?: string }).status === 'created')).toBe(true)
    expect(db.findCalls('payment_orders', 'update').some(([p]) => (p as { status?: string }).status === 'submitted')).toBe(true)

    db.reset()
    registerPaymentInitiationProvider(fakeProvider({ pollSigning: vi.fn().mockResolvedValue({ state: 'failed', challenge: null, failureCode: 'PSU_RIGHTS_MISSING' }) }))
    db.setTable('payment_order_batches', { data: signing })
    db.setTable('payment_orders', { data: inSigning })
    await pollPaymentSigning(ctx, { batchId: 'batch-1', signer: SIGNER })
    expect(db.findCalls('payment_orders', 'update').some(([p]) => (p as { status?: string }).status === 'failed')).toBe(true)
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
    const statusPatches = db.findCalls('payment_orders', 'update').map(([p]) => (p as { status?: string }).status)
    expect(statusPatches).toEqual(['accepted', 'awaiting_second_signer'])
    const batchPatch = db.findCalls('payment_order_batches', 'update').map(([p]) => (p as { status?: string }).status)
    expect(batchPatch).toContain('awaiting_second_signer')
  })
})
