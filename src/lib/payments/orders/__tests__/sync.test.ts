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
} as PaymentOrderBatchRow

function provider(getPaymentState: PaymentInitiationProvider['getPaymentState']): PaymentInitiationProvider {
  return { id: 'open_payments', isAvailableFor: () => true, getPaymentState } as unknown as PaymentInitiationProvider
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
    payment_order_events: { data: null },
    payment_orders: { data: [] },
  })
})

describe('syncPaymentOrderStatuses', () => {
  it('fails orders whose payment never reached the bank, even with no provider registered', async () => {
    db.setTable('payment_orders', [{ data: [{ id: 'o9', company_id: COMPANY }] }, { data: [] }])

    const result = await run()

    expect(result.failedStale).toBe(1)
    expect(result.noProvider).toBe(true)
    expect(patches('payment_orders')[0]).toMatchObject({ status: 'failed', provider_error_code: 'NOT_SENT_TO_BANK' })
    expect(db.findCalls('payment_orders', 'is')).toContainEqual(['provider_payment_id', null])
    expect(events()).toContainEqual(expect.objectContaining({ payment_order_id: 'o9', event_type: 'error', detail: { code: 'NOT_SENT_TO_BANK' } }))
  })

  it('asks the bank before calling a signing abandoned, and records one finished after the dialog closed', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSP', status: 'accepted', messages: [] })))
    db.setTable('payment_order_batches', [{ data: [SIGNING] }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', [
      { data: [] }, // stale claims
      { data: [order('o1'), order('o2')] }, // the batch's orders
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [] }, // in-flight poll
    ])

    const result = await run()

    expect(result).toMatchObject({ signedLate: 1, abandoned: 0, moved: 2 })
    expect(patches('payment_orders').map((p) => p.status)).toEqual(['failed', 'accepted', 'accepted'])
    expect(patches('payment_order_batches')).toEqual([expect.objectContaining({ status: 'signed' })])
    expect(events()).toContainEqual(expect.objectContaining({ batch_id: 'batch-1', event_type: 'status_changed', to_status: 'signed' }))
    expect(events().some((e) => (e.detail as { code?: string }).code === 'SIGNING_ABANDONED')).toBe(false)
  })

  it('sends a signing that is still unsigned at the bank back to be signed again', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'RCVD', status: 'submitted', messages: [] })))
    db.setTable('payment_order_batches', [{ data: [SIGNING] }, { data: [{ id: 'batch-1' }] }])
    db.setTable('payment_orders', [
      { data: [] },
      { data: [order('o1'), order('o2')] },
      { data: [{ id: 'o1' }] },
      { data: [{ id: 'o2' }] },
      { data: [] }, // orders back to submitted
      { data: [] },
    ])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 1, signedLate: 0, moved: 0 })
    expect(patches('payment_order_batches')).toEqual([{ status: 'created' }])
    expect(patches('payment_orders').at(-1)).toEqual({ status: 'submitted' })
    expect(events()).toContainEqual(expect.objectContaining({ batch_id: 'batch-1', event_type: 'error', detail: { code: 'SIGNING_ABANDONED' } }))
  })

  it('leaves the signing alone while the bank cannot be asked', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockRejectedValue(new PaymentProviderError('down', 'SERVICE_UNAVAILABLE', true, 503))))
    db.setTable('payment_order_batches', { data: [SIGNING] })
    db.setTable('payment_orders', [{ data: [] }, { data: [order('o1'), order('o2')] }, { data: [] }])

    const result = await run()

    expect(result).toMatchObject({ abandoned: 0, signedLate: 0, errors: 2 })
    expect(patches('payment_order_batches')).toEqual([])
  })

  it('moves payments the bank holds forward, executed included', async () => {
    registerPaymentInitiationProvider(provider(vi.fn().mockResolvedValue({ providerStatus: 'ACSC', status: 'executed', messages: [] })))
    db.setTable('payment_orders', [{ data: [] }, { data: [order('o1', { status: 'accepted' })] }, { data: [{ id: 'o1' }] }])

    const result = await run()

    expect(result).toMatchObject({ checked: 1, moved: 1 })
    expect(patches('payment_orders').at(-1)).toMatchObject({ status: 'executed', provider_status: 'ACSC' })
    expect(patches('payment_orders').at(-1)?.executed_at).toEqual(expect.any(String))
  })

  it('skips companies the registered provider does not serve', async () => {
    const getPaymentState = vi.fn()
    registerPaymentInitiationProvider({ ...provider(getPaymentState), isAvailableFor: () => false } as PaymentInitiationProvider)
    db.setTable('payment_orders', [{ data: [] }, { data: [order('o1', { status: 'accepted' })] }])

    const result = await run()

    expect(result).toMatchObject({ checked: 0, moved: 0, errors: 0 })
    expect(result.noProvider).toBeUndefined()
    expect(getPaymentState).not.toHaveBeenCalled()
  })

  it('stops after the stale-claim pass when the installation has no payments provider', async () => {
    const result = await run()

    expect(result).toEqual({ checked: 0, moved: 0, failedStale: 0, abandoned: 0, signedLate: 0, errors: 0, noProvider: true })
    // One write that matched nothing; no signing or in-flight order is read.
    expect(db.findCalls('payment_orders', 'update')).toHaveLength(1)
    expect(db.findCalls('payment_orders', 'select')).toHaveLength(1)
    expect(db.findCalls('payment_order_batches', 'select')).toHaveLength(0)
  })
})
