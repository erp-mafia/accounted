/**
 * The event outbox dispatcher (lib/events/outbox-dispatcher.ts).
 * Off: no database call. Shadow (E2): claim, then mark every claimed delivery
 * done with the attempt its claim returned, without running any consumer.
 * Async (E3): a delivery the bus deferred, of a consumer in
 * ASYNC_EVENT_CONSUMERS, runs that consumer with the outbox context; done on
 * success, failed with a doubling backoff (dead after the last attempt) on a
 * failure. Nothing else is ever run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

// The dispatcher's only consumer import: a stand-in webhooks consumer.
const webhooksHandle = vi.hoisted(() => vi.fn())
vi.mock('@/lib/composition/async-event-consumers', () => ({
  ASYNC_EVENT_CONSUMERS: [
    { id: 'webhooks', owner: 'platform', eventTypes: ['invoice.created', 'invoice.sent'], handle: webhooksHandle },
  ],
}))

import {
  DISPATCH_BATCH_SIZE,
  DISPATCH_LEASE_SECONDS,
  DISPATCH_MAX_ATTEMPTS,
  HANDLER_TIMEOUT_MS,
  OutboxError,
  dispatchEventOutbox,
  isOutboxNotDeployed,
  retryAfterSeconds,
  type ClaimedDelivery,
} from '../outbox-dispatcher'

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }

function mockSupabase(results: RpcResult[]) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => results.shift() ?? { data: [], error: null })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

function delivery(
  outboxId: number,
  consumerId: string,
  attempts: number,
  createdAt: string,
  inlineResult?: ClaimedDelivery['inline_result'],
): ClaimedDelivery {
  return {
    outbox_id: outboxId,
    consumer_id: consumerId,
    attempts,
    lease_until: '2026-10-17T10:01:00Z',
    company_id: null,
    event_type: 'invoice.created',
    payload: {},
    created_at: createdAt,
    ...(inlineResult !== undefined ? { inline_result: inlineResult } : {}),
  }
}

const NOW = Date.parse('2026-10-17T10:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  webhooksHandle.mockResolvedValue(undefined)
  vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dispatchEventOutbox', () => {
  it('makes no database call with the mode off', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', undefined)
    const { client, rpc } = mockSupabase([])
    const summary = await dispatchEventOutbox({ supabase: client })
    expect(rpc).not.toHaveBeenCalled()
    expect(summary).toEqual({
      mode: 'off',
      batches: 0,
      claimed: 0,
      completed: 0,
      ran: 0,
      retried: 0,
      dead: 0,
      oldestAgeMs: null,
      notDeployed: false,
    })
  })

  it('claims, then marks every claimed delivery done with its attempt, running nothing (shadow)', async () => {
    const { client, rpc } = mockSupabase([
      {
        data: [delivery(1, 'webhooks', 1, '2026-10-17T09:59:58Z'), delivery(1, 'attest-notify', 3, '2026-10-17T09:59:30Z')],
        error: null,
      },
      { data: 2, error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(rpc.mock.calls).toEqual([
      [
        'claim_event_deliveries',
        { p_limit: DISPATCH_BATCH_SIZE, p_lease_seconds: DISPATCH_LEASE_SECONDS, p_max_attempts: DISPATCH_MAX_ATTEMPTS },
      ],
      ['complete_event_deliveries', { p_outbox_ids: [1, 1], p_consumer_ids: ['webhooks', 'attest-notify'], p_attempts: [1, 3] }],
    ])
    expect(summary).toEqual({
      mode: 'shadow',
      batches: 1,
      claimed: 2,
      completed: 2,
      ran: 0,
      retried: 0,
      dead: 0,
      oldestAgeMs: 30_000,
      notDeployed: false,
    })
    expect(webhooksHandle).not.toHaveBeenCalled()
  })

  it('claims again while a claim comes back full, and stops at a short one', async () => {
    const { client, rpc } = mockSupabase([
      { data: [delivery(1, 'webhooks', 1, '2026-10-17T09:59:59Z'), delivery(2, 'webhooks', 1, '2026-10-17T09:59:59Z')], error: null },
      { data: 2, error: null },
      { data: [delivery(3, 'webhooks', 1, '2026-10-17T09:59:59Z')], error: null },
      { data: 1, error: null },
    ])
    const summary = await dispatchEventOutbox({ supabase: client, batchSize: 2, now: () => NOW })
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(summary).toMatchObject({ batches: 2, claimed: 3, completed: 3 })
  })

  it('stops at maxBatches (the kick makes one round trip)', async () => {
    const { client, rpc } = mockSupabase([
      { data: [delivery(1, 'webhooks', 1, '2026-10-17T09:59:59Z')], error: null },
      { data: 1, error: null },
    ])
    const summary = await dispatchEventOutbox({ supabase: client, batchSize: 1, maxBatches: 1, now: () => NOW })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(summary.batches).toBe(1)
  })

  it('stops when the budget is spent', async () => {
    let clock = NOW
    const { client, rpc } = mockSupabase([
      { data: [delivery(1, 'webhooks', 1, '2026-10-17T09:59:59Z')], error: null },
      { data: 1, error: null },
    ])
    rpc.mockImplementationOnce(async () => {
      clock += 30_000
      return { data: [delivery(1, 'webhooks', 1, '2026-10-17T09:59:59Z')], error: null }
    })
    const summary = await dispatchEventOutbox({ supabase: client, batchSize: 1, budgetMs: 25_000, now: () => clock })
    expect(summary.batches).toBe(1)
  })

  it('claims nothing more and completes nothing after an empty claim', async () => {
    const { client, rpc } = mockSupabase([{ data: [], error: null }])
    const summary = await dispatchEventOutbox({ supabase: client })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ batches: 1, claimed: 0, completed: 0, oldestAgeMs: null })
  })

  it('reports an outbox not deployed yet instead of failing', async () => {
    const { client } = mockSupabase([{ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }])
    const summary = await dispatchEventOutbox({ supabase: client })
    expect(summary).toMatchObject({ notDeployed: true, batches: 0, claimed: 0 })
  })

  it('throws on any other claim or completion failure', async () => {
    const claimFails = mockSupabase([{ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }])
    await expect(dispatchEventOutbox({ supabase: claimFails.client })).rejects.toBeInstanceOf(OutboxError)

    const completeFails = mockSupabase([
      { data: [delivery(1, 'webhooks', 1, '2026-10-17T09:59:59Z')], error: null },
      { data: null, error: { code: 'XX000', message: 'boom' } },
    ])
    await expect(dispatchEventOutbox({ supabase: completeFails.client })).rejects.toMatchObject({
      name: 'OutboxError',
      code: 'XX000',
    })
  })
})

describe('dispatchEventOutbox: deliveries the bus deferred (step E3)', () => {
  const CREATED = '2026-10-17T09:59:58Z'

  function rpcNames(rpc: ReturnType<typeof mockSupabase>['rpc']): string[] {
    return rpc.mock.calls.map(([name]) => name)
  }

  it('runs the webhooks consumer with the event, the service-role client and the outbox id, then marks it done', async () => {
    const row = { ...delivery(41, 'webhooks', 1, CREATED, 'deferred'), company_id: 'c1', payload: { companyId: 'c1', n: 1 } }
    const { client, rpc } = mockSupabase([{ data: [row], error: null }, { data: 1, error: null }])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(webhooksHandle).toHaveBeenCalledTimes(1)
    expect(webhooksHandle).toHaveBeenCalledWith(
      { type: 'invoice.created', payload: { companyId: 'c1', n: 1 } },
      { consumerId: 'webhooks', outbox: { outboxId: 41, attempt: 1, supabase: client } },
    )
    expect(rpc.mock.calls[1]).toEqual([
      'complete_event_deliveries',
      { p_outbox_ids: [41], p_consumer_ids: ['webhooks'], p_attempts: [1] },
    ])
    expect(summary).toMatchObject({ claimed: 1, completed: 1, ran: 1, retried: 0, dead: 0 })
  })

  it('never runs a consumer for a delivery that ran inline (shadow), whatever its consumer', async () => {
    const { client, rpc } = mockSupabase([
      {
        data: [
          delivery(1, 'webhooks', 1, CREATED, 'ok'),
          delivery(2, 'webhooks', 1, CREATED, 'failed'),
          delivery(3, 'webhooks', 1, CREATED, 'not_subscribed'),
          delivery(4, 'webhooks', 1, CREATED, null),
          delivery(5, 'attest-notify', 1, CREATED, 'ok'),
        ],
        error: null,
      },
      { data: 5, error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(webhooksHandle).not.toHaveBeenCalled()
    expect(rpcNames(rpc)).toEqual(['claim_event_deliveries', 'complete_event_deliveries'])
    expect(summary).toMatchObject({ completed: 5, ran: 0 })
  })

  it('runs only the deferred deliveries of a mixed batch and completes them with the shadow ones in one call', async () => {
    const { client, rpc } = mockSupabase([
      {
        data: [delivery(1, 'attest-notify', 1, CREATED, 'ok'), delivery(1, 'webhooks', 2, CREATED, 'deferred'), delivery(2, 'webhooks', 1, CREATED, 'ok')],
        error: null,
      },
      { data: 3, error: null },
    ])

    await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(webhooksHandle).toHaveBeenCalledTimes(1)
    expect(webhooksHandle.mock.calls[0]![1]).toMatchObject({ outbox: { outboxId: 1, attempt: 2 } })
    expect(rpc.mock.calls[1]).toEqual([
      'complete_event_deliveries',
      { p_outbox_ids: [1, 2, 1], p_consumer_ids: ['attest-notify', 'webhooks', 'webhooks'], p_attempts: [1, 1, 2] },
    ])
  })

  it('fails a delivery whose consumer threw: back to pending after a backoff that doubles per attempt', async () => {
    webhooksHandle.mockRejectedValueOnce(new Error('webhook fanout insert failed: deadlock detected (40P01)'))
    const { client, rpc } = mockSupabase([
      { data: [delivery(7, 'webhooks', 3, CREATED, 'deferred')], error: null },
      { data: 'pending', error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(rpc.mock.calls[1]).toEqual([
      'fail_event_delivery',
      {
        p_outbox_id: 7,
        p_consumer_id: 'webhooks',
        p_attempt: 3,
        p_error: 'webhook fanout insert failed: deadlock detected (40P01)',
        p_retry_after_seconds: 120,
        p_max_attempts: DISPATCH_MAX_ATTEMPTS,
      },
    ])
    // Nothing succeeded, so nothing to complete.
    expect(rpcNames(rpc)).not.toContain('complete_event_deliveries')
    expect(summary).toMatchObject({ ran: 1, completed: 0, retried: 1, dead: 0 })
    expect(logMock.warn).toHaveBeenCalledWith(
      'event outbox delivery failed; retried after backoff',
      expect.objectContaining({ outboxId: 7, consumerId: 'webhooks', attempt: 3, status: 'pending' }),
    )
  })

  it('reports a delivery dead once its last attempt failed, and logs it as an error', async () => {
    webhooksHandle.mockRejectedValueOnce(new Error('still down'))
    const { client, rpc } = mockSupabase([
      { data: [delivery(8, 'webhooks', DISPATCH_MAX_ATTEMPTS, CREATED, 'deferred')], error: null },
      { data: 'dead', error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_attempt: DISPATCH_MAX_ATTEMPTS, p_max_attempts: DISPATCH_MAX_ATTEMPTS })
    expect(summary).toMatchObject({ retried: 0, dead: 1 })
    expect(logMock.error).toHaveBeenCalledWith(
      'event outbox delivery dead',
      expect.any(Error),
      expect.objectContaining({ outboxId: 8, status: 'dead' }),
    )
  })

  it('lets one failure hold back no other delivery of the batch', async () => {
    webhooksHandle.mockImplementation(async (event: { payload: { n: number } }) => {
      if (event.payload.n === 2) throw new Error('boom')
    })
    const rows = [1, 2, 3].map((n) => ({ ...delivery(n, 'webhooks', 1, CREATED, 'deferred'), payload: { n } }))
    const { client, rpc } = mockSupabase([
      { data: rows, error: null },
      { data: 2, error: null },
      { data: 'pending', error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(webhooksHandle).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls[1]).toEqual([
      'complete_event_deliveries',
      { p_outbox_ids: [1, 3], p_consumer_ids: ['webhooks', 'webhooks'], p_attempts: [1, 1] },
    ])
    expect(rpc.mock.calls[2]![0]).toBe('fail_event_delivery')
    expect(rpc.mock.calls[2]![1]).toMatchObject({ p_outbox_id: 2, p_error: 'boom' })
    expect(summary).toMatchObject({ ran: 3, completed: 2, retried: 1 })
  })

  it('never runs a deferred delivery of a consumer it has no async handler for: failed, not marked done', async () => {
    const { client, rpc } = mockSupabase([
      { data: [delivery(9, 'attest-notify', 1, CREATED, 'deferred')], error: null },
      { data: 'pending', error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(webhooksHandle).not.toHaveBeenCalled()
    expect(rpcNames(rpc)).toEqual(['claim_event_deliveries', 'fail_event_delivery'])
    expect(rpc.mock.calls[1]![1]).toMatchObject({
      p_consumer_id: 'attest-notify',
      p_error: "no async consumer 'attest-notify' in this deployment",
    })
    expect(summary).toMatchObject({ ran: 0, completed: 0, retried: 1 })
  })

  it('fails a deferred delivery of an event type its consumer does not handle, without running it', async () => {
    const row = { ...delivery(10, 'webhooks', 1, CREATED, 'deferred'), event_type: 'transaction.synced' }
    const { client, rpc } = mockSupabase([{ data: [row], error: null }, { data: 'pending', error: null }])

    await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(webhooksHandle).not.toHaveBeenCalled()
    expect(rpc.mock.calls[1]![1]).toMatchObject({ p_error: "consumer 'webhooks' does not handle transaction.synced" })
  })

  it('fails a consumer run that outlasts HANDLER_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    try {
      webhooksHandle.mockImplementation(() => new Promise(() => {}))
      const { client, rpc } = mockSupabase([
        { data: [delivery(11, 'webhooks', 1, CREATED, 'deferred')], error: null },
        { data: 'pending', error: null },
      ])

      const cycle = dispatchEventOutbox({ supabase: client, now: () => NOW })
      await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS + 1)
      const summary = await cycle

      expect(rpc.mock.calls[1]![1]).toMatchObject({ p_error: `timed out after ${HANDLER_TIMEOUT_MS} ms` })
      expect(summary).toMatchObject({ retried: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a failure whose claim was lost (a newer claim owns the delivery) neither retried nor dead', async () => {
    webhooksHandle.mockRejectedValueOnce(new Error('slow'))
    const { client } = mockSupabase([
      { data: [delivery(13, 'webhooks', 1, CREATED, 'deferred')], error: null },
      { data: 'lease_lost', error: null },
    ])

    const summary = await dispatchEventOutbox({ supabase: client, now: () => NOW })

    expect(summary).toMatchObject({ ran: 1, completed: 0, retried: 0, dead: 0 })
    expect(logMock.warn).toHaveBeenCalledWith(
      'event outbox delivery failed after its claim was lost; the newer claim owns it',
      expect.objectContaining({ outboxId: 13, status: 'lease_lost' }),
    )
  })

  it('throws when a failure cannot be recorded', async () => {
    webhooksHandle.mockRejectedValueOnce(new Error('boom'))
    const { client } = mockSupabase([
      { data: [delivery(12, 'webhooks', 1, CREATED, 'deferred')], error: null },
      { data: null, error: { code: 'XX000', message: 'fail broke' } },
    ])
    await expect(dispatchEventOutbox({ supabase: client, now: () => NOW })).rejects.toMatchObject({
      name: 'OutboxError',
      code: 'XX000',
    })
  })
})

describe('retryAfterSeconds', () => {
  it('doubles from 30 seconds per attempt and stops at an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryAfterSeconds)).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600])
    expect(retryAfterSeconds(50)).toBe(3600)
    expect(retryAfterSeconds(0)).toBe(30)
  })
})

describe('isOutboxNotDeployed', () => {
  it('recognises a missing function or table only', () => {
    for (const code of ['PGRST202', 'PGRST205', '42883', '42P01']) expect(isOutboxNotDeployed({ code })).toBe(true)
    for (const code of ['42501', 'XX000', undefined]) expect(isOutboxNotDeployed({ code })).toBe(false)
    expect(isOutboxNotDeployed(null)).toBe(false)
  })
})
