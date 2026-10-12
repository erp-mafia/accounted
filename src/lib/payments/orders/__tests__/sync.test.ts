import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  PaymentProviderError,
  registerPaymentInitiationProvider,
  resetPaymentInitiationProviders,
  type PaymentInitiationProvider,
} from '@/lib/payments/initiation/provider'
import type { Logger } from '@/lib/logger'
import { syncPaymentOrderStatuses } from '../sync'
import type { PaymentOrderBatchRow, PaymentOrderRow } from '../types'

const COMPANY = 'company-1'

function order(id: string, overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id,
    company_id: COMPANY,
    supplier_invoice_id: `inv-${id}`,
    amount: 737.5,
    batch_id: 'batch-1',
    status: 'awaiting_signature',
    debtor_snapshot: { iban: 'SE3550000000054910000003', bban: null, bic: 'ESSESESS', name: 'Konto', currency: 'SEK', bank_name: null },
    provider_payment_id: `pay-${id}`,
    provider_payment_product: 'swedish-giro',
    ...overrides,
  } as PaymentOrderRow
}

const SIGNING = {
  id: 'batch-1',
  company_id: COMPANY,
  status: 'awaiting_signature',
  signing_target: 'basket',
  signing_started_at: '2026-09-30T08:00:00Z',
  provider_authorisation_id: 'auth-1',
} as PaymentOrderBatchRow

function provider(
  getPaymentState: PaymentInitiationProvider['getPaymentState'],
  cancelPayment: PaymentInitiationProvider['cancelPayment'] = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' }),
): PaymentInitiationProvider {
  return { id: 'open_payments', isAvailableFor: () => true, getPaymentState, cancelPayment } as unknown as PaymentInitiationProvider
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
let db: ReturnType<typeof createTableMockSupabase>

function patches(table: string): Array<Record<string, unknown>> {
  return db.findCalls(table, 'update').map(([p]) => p as Record<string, unknown>)
}

function events(): Array<Record<string, unknown>> {
  return db.findCalls('payment_order_events', 'insert').flatMap(([rows]) => rows as Array<Record<string, unknown>>)
}

async function run() {
  return syncPaymentOrderStatuses(db.supabase as unknown as SupabaseClient, log)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetPaymentInitiationProviders()
  db = createTableMockSupabase({
    company_settings: { data: { org_number: '556677-8899' } },
    payment_order_batches: { data: [] },
    payment_order_events: { data: [] },
    payment_orders: { data: [] },
    supplier_invoices: { data: [] },
    'rpc:sweep_stale_payment_order_claims': { data: { marked_unknown: 0, released: 0 } },
    'rpc:release_payment_order': { data: { ok: true, status: 'cancelled' } },
  })
})

const UNPAID = { company_id: COMPANY, status: 'approved', is_credit_note: false, remaining_amount: 737.5 }
const PAID = { company_id: COMPANY, status: 'paid', is_credit_note: false, remaining_amount: 0 }

describe('syncPaymentOrderStatuses', () => {
  it('reads a status with the sparbank and the account context the paying account was connected with', async () => {
    const getPaymentState = vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] })
    registerPaymentInitiationProvider(provider(getPaymentState))
    const sparbank = { ...order('o1').debtor_snapshot, bic: 'SWEDSESS', affiliated_aspsp_id: '08999', psu_type: 'personal' }
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted', debtor_snapshot: sparbank })] }, { data: [{ id: 'o1' }] }])

    await run()

    expect(getPaymentState).toHaveBeenCalledWith(
      expect.objectContaining({ debtorBic: 'SWEDSESS', affiliatedAspspId: '08999', accountContext: 'private', signerPersonalNumber: null }),
      'pay-o1',
      'swedish-giro',
    )
  })

  it('sweeps claims nobody finished in one database call, before anything else and even with no provider registered', async () => {
    db.setTable('rpc:sweep_stale_payment_order_claims', { data: { marked_unknown: 1, released: 2 } })

    const result = await run()
    const after = Date.now()

    expect(result).toMatchObject({ markedUnknown: 1, released: 2, noProvider: true })
    const [[args]] = db.findCalls('rpc:sweep_stale_payment_order_claims', 'rpc') as [[{ p_before: string }]]
    // Well past the signing routes' maxDuration, so a create still running is never swept.
    // Measured against a clock read after the call: the window is computed inside it.
    expect(after - Date.parse(args.p_before)).toBeGreaterThanOrEqual(15 * 60_000)
    expect(db.findCalls('payment_orders', 'update')).toEqual([])
  })

  it('asks the bank before calling a signing abandoned, and records one finished after the dialog closed', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSP', status: 'accepted', messages: [] })))
    db.setTable('payment_order_batches', [{ data: [SIGNING] }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] }, // the batch's orders
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [] }, // in-flight poll
    ])

    const result = await run()

    expect(result).toMatchObject({ signedLate: 1, abandoned: 0, moved: 2 })
    expect(patches('payment_orders').map((p) => p.status)).toEqual(['accepted', 'accepted'])
    expect(patches('payment_order_batches')).toEqual([expect.objectContaining({ status: 'signed' })])
    expect(events()).toContainEqual(expect.objectContaining({ batch_id: 'batch-1', event_type: 'status_changed', to_status: 'signed' }))
    expect(events().some((e) => (e.detail as { code?: string }).code === 'SIGNING_ABANDONED')).toBe(false)
  })

  it('sends a signing that is still unsigned at the bank back to be signed again', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] })))
    db.setTable('payment_order_batches', [{ data: [SIGNING] }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', [
      { data: [order('o1'), order('o2')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [] }, // orders back to submitted
      { data: [] },
    ])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 1, signedLate: 0, moved: 0 })
    expect(patches('payment_order_batches')).toEqual([{ status: 'created' }])
    // Only the attempt that was read: a restart since then has another id.
    expect(db.findCalls('payment_order_batches', 'eq')).toContainEqual(['provider_authorisation_id', 'auth-1'])
    expect(patches('payment_orders').at(-1)).toEqual({ status: 'submitted' })
    expect(events()).toContainEqual(expect.objectContaining({ batch_id: 'batch-1', event_type: 'error', detail: { code: 'SIGNING_ABANDONED' } }))
  })

  it('leaves the signing alone when nobody can ask the bank (no provider, or no organisation number)', async () => {
    const getPaymentState = vi.fn()
    registerPaymentInitiationProvider(provider(getPaymentState))
    db.setTable('company_settings', { data: null })
    db.setTable('companies', { data: null })
    db.setTable('payment_order_batches', { data: [SIGNING] })
    db.setTable('payment_orders', [{ data: [order('o1'), order('o2')] }, { data: [] }])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 0, signedLate: 0 })
    expect(patches('payment_order_batches')).toEqual([])
    expect(getPaymentState).not.toHaveBeenCalled()
  })

  it('leaves the signing alone while the bank cannot be asked', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503))))
    db.setTable('payment_order_batches', { data: [SIGNING] })
    db.setTable('payment_orders', [{ data: [order('o1'), order('o2')] }, { data: [] }])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 0, signedLate: 0, errors: 2 })
    expect(patches('payment_order_batches')).toEqual([])
  })

  it('moves payments the bank holds forward, executed included', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSC', status: 'executed', messages: [] })))
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'accepted' })] }, { data: [{ id: 'o1' }] }])

    const result = await run()

    expect(result).toMatchObject({ checked: 1, moved: 1 })
    expect(patches('payment_orders').at(-1)).toMatchObject({ status: 'executed', provider_status: 'ACSC' })
    expect(patches('payment_orders').at(-1)?.executed_at).toEqual(expect.any(String))
  })

  it('skips companies the registered provider does not serve', async () => {
    const getPaymentState = vi.fn()
    registerPaymentInitiationProvider({ ...provider(getPaymentState), isAvailableFor: () => false } as PaymentInitiationProvider)
    db.setTable('payment_orders', { data: [order('o1', { status: 'accepted' })] })

    const result = await run()

    expect(result).toMatchObject({ checked: 0, moved: 0, errors: 0 })
    expect(result.noProvider).toBeUndefined()
    expect(getPaymentState).not.toHaveBeenCalled()
  })

  it('stops after the stale-claim sweep when the installation has no payments provider', async () => {
    const result = await run()

    expect(result).toEqual({
      checked: 0,
      moved: 0,
      markedUnknown: 0,
      released: 0,
      abandoned: 0,
      signedLate: 0,
      cancelledForClosedInvoice: 0,
      heldForPerson: 0,
      errors: 0,
      noProvider: true,
    })
    expect(db.findCalls('payment_orders', 'select')).toHaveLength(0)
    expect(db.findCalls('payment_order_batches', 'select')).toHaveLength(0)
  })

  it('cancels at the bank an unsigned payment whose invoice was paid another way, cancelling its order', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'cancelled', providerStatus: 'CANC' })
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }, { id: 'inv-o2', ...UNPAID }] })
    db.setTable('payment_orders', [
      { data: [order('o1', { status: 'submitted' }), order('o2', { status: 'submitted' })] },
      { data: [{ id: 'o1' }] }, // o1 status refreshed
      { data: { id: 'o1' } }, // o1 still waits with its payment
      { data: [{ id: 'o2' }] },
    ])

    const result = await run()

    expect(result).toMatchObject({ cancelledForClosedInvoice: 1, heldForPerson: 0 })
    expect(cancelPayment).toHaveBeenCalledTimes(1)
    expect(cancelPayment).toHaveBeenCalledWith(
      expect.objectContaining({ signerPersonalNumber: null, accountContext: 'corporate', affiliatedAspspId: null }),
      'pay-o1',
      'swedish-giro',
    )
    expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([
      [expect.objectContaining({ p_order_id: 'o1', p_provider_payment_id: 'pay-o1', p_provider_status: 'CANC', p_reason: 'INVOICE_CLOSED', p_user_id: null })],
    ])
  })

  it('holds for a person a payment whose cancel the bank does not confirm, and does not ask again', async () => {
    const cancelPayment = vi.fn().mockResolvedValue({ outcome: 'not_cancelled', providerStatus: 'RCVD' })
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted' })] }, { data: [{ id: 'o1' }] }, { data: { id: 'o1' } }])

    const first = await run()

    expect(first).toMatchObject({ cancelledForClosedInvoice: 0, heldForPerson: 1 })
    expect(db.findCalls('rpc:release_payment_order', 'rpc')).toEqual([])
    expect(events()).toContainEqual(
      expect.objectContaining({
        payment_order_id: 'o1',
        event_type: 'cancel_requested',
        detail: expect.objectContaining({ source: 'invoice_closed', provider_payment_id: 'pay-o1', answer: 'not_cancelled' }),
      }),
    )

    // The next run finds the attempt on record and leaves the order to a person.
    db.reset()
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_order_events', { data: [{ payment_order_id: 'o1', detail: { source: 'invoice_closed', provider_payment_id: 'pay-o1' } }] })
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted' })] }, { data: [{ id: 'o1' }] }])
    cancelPayment.mockClear()

    const second = await run()

    expect(second).toMatchObject({ cancelledForClosedInvoice: 0, heldForPerson: 0 })
    expect(cancelPayment).not.toHaveBeenCalled()
  })

  it('tries a cancel that never reached the bank again on the next run', async () => {
    const cancelPayment = vi.fn().mockRejectedValue(new PaymentProviderError('busy', 'RATE_LIMITED', true, 429))
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] }), cancelPayment))
    db.setTable('supplier_invoices', { data: [{ id: 'inv-o1', ...PAID }] })
    db.setTable('payment_orders', [{ data: [order('o1', { status: 'submitted' })] }, { data: [{ id: 'o1' }] }, { data: { id: 'o1' } }])

    const result = await run()

    expect(result).toMatchObject({ cancelledForClosedInvoice: 0, heldForPerson: 0 })
    expect(cancelPayment).toHaveBeenCalledTimes(1)
    expect(events().some((e) => e.event_type === 'cancel_requested')).toBe(false)
  })
})
