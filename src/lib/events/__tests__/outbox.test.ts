/**
 * The event outbox writer and its dispatch kick (lib/events/outbox.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const afterMock = vi.hoisted(() => vi.fn())
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: afterMock }
})

const rpcResult = vi.hoisted(() => ({ value: { data: 42 as unknown, error: null as unknown } }))
const supabaseMock = vi.hoisted(() => {
  const abortSignal = vi.fn()
  const rpc = vi.fn()
  return { rpc, abortSignal }
})
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: vi.fn(() => ({ rpc: supabaseMock.rpc })),
}))

import { eventBus } from '../bus'
import {
  ENQUEUE_TIMEOUT_MS,
  KICK_BATCH_SIZE,
  installEventOutbox,
  kickEventOutboxDispatch,
  resetOutboxKickForTests,
  writeShadowDeliveries,
} from '../outbox'
import type { CoreEvent } from '../types'
import type { SupplierInvoice } from '@/types'

const COMPANY = '00000000-0000-4000-8000-000000000001'

const event: CoreEvent = {
  type: 'supplier_invoice.registered',
  payload: { supplierInvoice: { id: 'si-1' } as SupplierInvoice, userId: 'u1', companyId: COMPANY },
}

beforeEach(() => {
  vi.clearAllMocks()
  resetOutboxKickForTests()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  rpcResult.value = { data: 42, error: null }
  supabaseMock.rpc.mockImplementation(() => {
    const builder = {
      abortSignal: (signal: AbortSignal) => {
        supabaseMock.abortSignal(signal)
        return builder
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rpcResult.value).then(resolve, reject),
    }
    return builder
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  eventBus.setOutboxWriter(null)
})

describe('writeShadowDeliveries', () => {
  it('writes the event and its deliveries in one enqueue_event call, bounded by a timeout', async () => {
    await writeShadowDeliveries(event, [
      { consumerId: 'attest-notify', inline: 'failed' },
      { consumerId: 'webhooks', inline: 'ok' },
    ])

    expect(supabaseMock.rpc).toHaveBeenCalledWith('enqueue_event', {
      p_event_type: 'supplier_invoice.registered',
      p_company_id: COMPANY,
      p_payload: event.payload,
      p_consumer_ids: ['attest-notify', 'webhooks'],
      p_inline_results: { 'attest-notify': 'failed', webhooks: 'ok' },
    })
    expect(supabaseMock.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(ENQUEUE_TIMEOUT_MS).toBeLessThanOrEqual(5000)
    // It wrote something: one dispatch cycle is scheduled after the response.
    expect(afterMock).toHaveBeenCalledTimes(1)
  })

  it('stores no company for a companyId that is not a uuid', async () => {
    await writeShadowDeliveries(
      { ...event, payload: { ...event.payload, companyId: 'company-1' } } as CoreEvent,
      [{ consumerId: 'webhooks', inline: 'ok' }],
    )
    expect(supabaseMock.rpc).toHaveBeenCalledWith('enqueue_event', expect.objectContaining({ p_company_id: null }))
  })

  it('schedules no dispatch when nothing was written (a dedupe key already there)', async () => {
    rpcResult.value = { data: null, error: null }
    await writeShadowDeliveries(event, [{ consumerId: 'webhooks', inline: 'ok' }])
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('throws on a failed enqueue, an outbox not deployed included, for the bus to log', async () => {
    rpcResult.value = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.enqueue_event' } }
    await expect(writeShadowDeliveries(event, [{ consumerId: 'webhooks', inline: 'ok' }])).rejects.toMatchObject({
      name: 'OutboxError',
      code: 'PGRST202',
    })
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('throws without a Supabase configuration and makes no call', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    await expect(writeShadowDeliveries(event, [{ consumerId: 'webhooks', inline: 'ok' }])).rejects.toThrow(
      /no Supabase service configuration/,
    )
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })

  it('makes no call for no deliveries', async () => {
    await writeShadowDeliveries(event, [])
    expect(supabaseMock.rpc).not.toHaveBeenCalled()
  })
})

describe('kickEventOutboxDispatch', () => {
  it('coalesces a burst into one cycle after the response: one claim round trip of KICK_BATCH_SIZE', async () => {
    const dispatch = vi.fn().mockResolvedValue({})
    kickEventOutboxDispatch(dispatch)
    kickEventOutboxDispatch(dispatch)
    kickEventOutboxDispatch(dispatch)
    expect(afterMock).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()

    await afterMock.mock.calls[0]![0]()
    expect(dispatch).toHaveBeenCalledWith({ supabase: expect.anything(), batchSize: KICK_BATCH_SIZE, maxBatches: 1 })

    // Ran: the next emit gets a cycle of its own.
    kickEventOutboxDispatch(dispatch)
    expect(afterMock).toHaveBeenCalledTimes(2)
  })

  it('never throws: a failed cycle is left to the cron', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('claim failed'))
    kickEventOutboxDispatch(dispatch)
    await expect(afterMock.mock.calls[0]![0]()).resolves.toBeUndefined()
  })

  it('runs as a deferred promise outside a request scope', async () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error('`after` was called outside a request scope')
    })
    const dispatch = vi.fn().mockResolvedValue({})
    kickEventOutboxDispatch(dispatch)
    expect(dispatch).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

describe('installEventOutbox', () => {
  it('installs the writer on the event bus', () => {
    const set = vi.spyOn(eventBus, 'setOutboxWriter')
    installEventOutbox()
    expect(set).toHaveBeenCalledWith(writeShadowDeliveries)
  })
})
