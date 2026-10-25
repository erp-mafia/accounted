/**
 * Tests for the event_log cleanup cron: roll agent telemetry into the
 * anonymous daily tables first (rollup_agent_telemetry), then delivery events
 * past 30 days (prune_delivery_events), then everything past 180 days only
 * after a rollup that succeeded, then the event outbox prune, best effort.
 * The steps are independent: one failing never stops the others.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

interface FilterCall {
  method: string
  args: unknown[]
}

interface DeleteCapture {
  filters: FilterCall[]
}

type RpcResult = { data: unknown; error: unknown }

const deleteCalls: DeleteCapture[] = []
let deleteResults: Array<{ error: unknown; count: number | null }> = []
// What happened, in order: 'delete' per event_log delete, the RPC name per call.
const timeline: string[] = []
let rollupResults: RpcResult[] = []
let deliveryResults: RpcResult[] = []
let pruneResult: RpcResult = { data: 0, error: null }
function defaultRpc(name: string, _args?: unknown): Promise<RpcResult> {
  timeline.push(name)
  if (name === 'rollup_agent_telemetry') return Promise.resolve(rollupResults.shift() ?? { data: 0, error: null })
  if (name === 'prune_delivery_events') return Promise.resolve(deliveryResults.shift() ?? { data: 0, error: null })
  return Promise.resolve(pruneResult)
}
const rpc = vi.fn(defaultRpc)

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    rpc: (name: string, args?: unknown) => rpc(name, args),
    from: vi.fn(() => {
      const capture: DeleteCapture = { filters: [] }
      deleteCalls.push(capture)
      timeline.push('delete')
      const result = deleteResults.shift() ?? { error: null, count: 0 }
      const chain: Record<string, unknown> = {}
      chain.delete = vi.fn(() => chain)
      chain.lt = vi.fn((...args: unknown[]) => {
        capture.filters.push({ method: 'lt', args })
        return chain
      })
      chain.not = vi.fn((...args: unknown[]) => {
        capture.filters.push({ method: 'not', args })
        return chain
      })
      // Thenable: awaiting the builder resolves the queued result.
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    }),
  })),
}))

import { GET } from '../route'
import { createCronRequest } from '@/tests/helpers'

function daysAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

function callsTo(name: string) {
  return rpc.mock.calls.filter(([n]) => n === name)
}

beforeEach(() => {
  vi.clearAllMocks()
  deleteCalls.length = 0
  deleteResults = []
  timeline.length = 0
  rollupResults = []
  deliveryResults = []
  pruneResult = { data: 0, error: null }
  rpc.mockImplementation(defaultRpc)
})

describe('GET /api/events/cleanup/cron', () => {
  it('rolls up, prunes delivery events at 30 days, purges everything at 180, then the outbox', async () => {
    rollupResults = [{ data: 1, error: null }, { data: 0, error: null }]
    deliveryResults = [{ data: 12, error: null }]
    deleteResults = [{ error: null, count: 3 }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toEqual({
      success: true,
      deleted: 15,
      deletedDelivery: 12,
      deletedTelemetry: 3,
      rolledUpDays: 1,
      prunedOutbox: 0,
    })
    expect(timeline).toEqual(['rollup_agent_telemetry', 'rollup_agent_telemetry', 'prune_delivery_events', 'delete', 'prune_event_outbox'])

    const rollup = callsTo('rollup_agent_telemetry')[0][1] as { p_since: string; p_max_days: number }
    expect(rollup.p_max_days).toBe(1)
    expect(daysAgo(rollup.p_since)).toBeCloseTo(181, 0)

    const delivery = callsTo('prune_delivery_events')[0][1] as { p_before: string; p_limit: number }
    expect(daysAgo(delivery.p_before)).toBeCloseTo(30, 0)
    expect(delivery.p_limit).toBe(20_000)

    // The 180-day purge has no type filter: it sweeps the telemetry rows.
    const lt = deleteCalls[0].filters.find((f) => f.method === 'lt')!
    expect(lt.args[0]).toBe('created_at')
    expect(daysAgo(lt.args[1] as string)).toBeCloseTo(180, 0)
    expect(deleteCalls[0].filters.filter((f) => f.method === 'not')).toHaveLength(0)
  })

  it('catches up at most seven telemetry days a night', async () => {
    rollupResults = Array.from({ length: 10 }, () => ({ data: 1, error: null }))

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toMatchObject({ success: true, rolledUpDays: 7 })
    expect(callsTo('rollup_agent_telemetry')).toHaveLength(7)
  })

  it('prunes delivery events in batches until one comes back short', async () => {
    deliveryResults = [{ data: 20_000, error: null }, { data: 20_000, error: null }, { data: 512, error: null }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toMatchObject({ success: true, deletedDelivery: 40_512 })
    expect(callsTo('prune_delivery_events')).toHaveLength(3)
  })

  it('skips only the telemetry purge when the rollup fails, and answers with an error', async () => {
    rollupResults = [{ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }]
    deliveryResults = [{ data: 4, error: null }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    // No telemetry row was deleted uncounted; delivery events and the outbox still went.
    expect(timeline).toEqual(['rollup_agent_telemetry', 'prune_delivery_events', 'prune_event_outbox'])
    expect(deleteCalls).toHaveLength(0)
  })

  it('still rolls up and purges telemetry when the delivery prune fails', async () => {
    rollupResults = [{ data: 1, error: null }, { data: 0, error: null }]
    deliveryResults = [{ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(timeline).toEqual(['rollup_agent_telemetry', 'rollup_agent_telemetry', 'prune_delivery_events', 'delete', 'prune_event_outbox'])
  })

  it('answers with an error when the telemetry purge fails', async () => {
    deleteResults = [{ error: { message: 'boom', code: 'XX000' }, count: null }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(timeline).toContain('prune_event_outbox')
  })

  it('prunes the event outbox after the event_log steps', async () => {
    pruneResult = { data: 7, error: null }
    const response = await GET(createCronRequest('/api/events/cleanup/cron'))
    expect(rpc).toHaveBeenCalledWith('prune_event_outbox', undefined)
    expect(await response.json()).toMatchObject({ success: true, prunedOutbox: 7 })
  })

  it.each([
    ['not deployed yet', { code: 'PGRST202', message: 'Could not find the function public.prune_event_outbox' }],
    ['failing', { code: 'XX000', message: 'boom' }],
  ])('still answers the event_log cleanup when the outbox prune is %s', async (_label, error) => {
    deliveryResults = [{ data: 4, error: null }]
    deleteResults = [{ error: null, count: 1 }]
    pruneResult = { data: null, error }
    const response = await GET(createCronRequest('/api/events/cleanup/cron'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      deleted: 5,
      deletedDelivery: 4,
      deletedTelemetry: 1,
      rolledUpDays: 0,
      prunedOutbox: 0,
    })
  })
})
