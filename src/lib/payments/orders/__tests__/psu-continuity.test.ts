import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { registerPaymentInitiationProvider, resetPaymentInitiationProviders } from '@/lib/payments/initiation/provider'
import type { OperationContext } from '@/lib/operations/types'
import { COMPANY, fakeProvider, USER, waitingOrder } from './fixtures'

const mock = vi.hoisted(() => ({ supabase: null as unknown, storedBatchPsu: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mock.supabase }))
vi.mock('@/lib/auth/resource-psu', () => ({ storedBatchPsu: (...a: unknown[]) => mock.storedBatchPsu(...a) }))

import { cancelPaymentOrder, resolvePaymentOrder } from '../lifecycle'

const KEPT_PSU = '198001019879'
const PRESENT = { ipAddress: '203.0.113.10', userAgent: 'UA' }
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
  mock.storedBatchPsu.mockReset().mockResolvedValue(KEPT_PSU)
  ctx = { supabase: db.supabase as never, companyId: COMPANY, userId: USER, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never }
})

describe('a person acting on a payment the bank holds', () => {
  it('cancels with the PSU-ID the payment was created with, their own IP and user agent along', async () => {
    const provider = fakeProvider({ cancelPayment: vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [{ data: [waitingOrder('o1', 1, { status: 'submitted' })] }, { data: [{ id: 'o1' }] }])

    expect(await cancelPaymentOrder(ctx, { orderId: 'o1', signer: PRESENT })).toEqual({ ok: true, data: { cancelled: true, status: 'cancelled' } })
    expect(mock.storedBatchPsu).toHaveBeenCalledWith('batch-1')
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU, psuIpAddress: '203.0.113.10', psuUserAgent: 'UA' }), 'pay-1', 'swedish-giro')
    // The kept number stands in for the one on file.
    expect(db.tables()).not.toContain('bankid_identities')
  })

  it('falls back to the person\'s number on file when nothing is kept for the signing', async () => {
    mock.storedBatchPsu.mockResolvedValue(null)
    db.setTable('bankid_identities', { data: null })
    const provider = fakeProvider({ cancelPayment: vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', [{ data: [waitingOrder('o1', 1, { status: 'submitted' })] }, { data: [{ id: 'o1' }] }])

    await cancelPaymentOrder(ctx, { orderId: 'o1', signer: PRESENT })
    expect(db.tables()).toContain('bankid_identities')
    expect(provider.cancelPayment).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: null }), 'pay-1', 'swedish-giro')
  })

  it('asks the bank about a stranded payment with the same PSU-ID before a person may settle it', async () => {
    const provider = fakeProvider({ getPaymentState: vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }) })
    registerPaymentInitiationProvider(provider)
    db.setTable('payment_orders', { data: [waitingOrder('o1', 1, { status: 'submitted' })] })

    expect(await resolvePaymentOrder(ctx, { orderId: 'o1', resolution: 'not_at_bank', signer: PRESENT })).toMatchObject({ ok: false, code: 'PAYMENT_ORDER_AT_BANK' })
    expect(provider.getPaymentState).toHaveBeenCalledWith(expect.objectContaining({ signerPersonalNumber: KEPT_PSU }), 'pay-1', 'swedish-giro')
  })
})
