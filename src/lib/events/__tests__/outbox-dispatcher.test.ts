/**
 * The event outbox dispatcher (lib/events/outbox-dispatcher.ts), step E2.
 * Off: no database call. Shadow: claim, then mark every claimed delivery done
 * with the attempt its claim returned, without running any consumer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DISPATCH_BATCH_SIZE,
  DISPATCH_LEASE_SECONDS,
  DISPATCH_MAX_ATTEMPTS,
  OutboxError,
  dispatchEventOutbox,
  isOutboxNotDeployed,
  type ClaimedDelivery,
} from '../outbox-dispatcher'

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }

function mockSupabase(results: RpcResult[]) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => results.shift() ?? { data: [], error: null })
  return { client: { rpc } as unknown as SupabaseClient, rpc }
}

function delivery(outboxId: number, consumerId: string, attempts: number, createdAt: string): ClaimedDelivery {
  return {
    outbox_id: outboxId,
    consumer_id: consumerId,
    attempts,
    lease_until: '2026-10-17T10:01:00Z',
    company_id: null,
    event_type: 'invoice.created',
    payload: {},
    created_at: createdAt,
  }
}

const NOW = Date.parse('2026-10-17T10:00:00Z')

beforeEach(() => {
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
    expect(summary).toEqual({ mode: 'off', batches: 0, claimed: 0, completed: 0, oldestAgeMs: null, notDeployed: false })
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
    expect(summary).toEqual({ mode: 'shadow', batches: 1, claimed: 2, completed: 2, oldestAgeMs: 30_000, notDeployed: false })
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

describe('isOutboxNotDeployed', () => {
  it('recognises a missing function or table only', () => {
    for (const code of ['PGRST202', 'PGRST205', '42883', '42P01']) expect(isOutboxNotDeployed({ code })).toBe(true)
    for (const code of ['42501', 'XX000', undefined]) expect(isOutboxNotDeployed({ code })).toBe(false)
    expect(isOutboxNotDeployed(null)).toBe(false)
  })
})
