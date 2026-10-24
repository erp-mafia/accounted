/**
 * Tests for the event_log cleanup cron's differentiated retention:
 * delivery events at 30 days, agent telemetry (mcp.*, agent.*) at 180 days
 * after it is rolled into the anonymous daily tables (rollup_agent_telemetry,
 * fail closed); then the event outbox prune (prune_event_outbox), best effort.
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
let pruneResult: RpcResult = { data: 0, error: null }
const rpc = vi.fn((name: string, _args?: unknown): Promise<RpcResult> => {
  timeline.push(name)
  if (name === 'rollup_agent_telemetry') return Promise.resolve(rollupResults.shift() ?? { data: 0, error: null })
  return Promise.resolve(pruneResult)
})

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

function rollupCalls() {
  return rpc.mock.calls.filter(([name]) => name === 'rollup_agent_telemetry')
}

beforeEach(() => {
  vi.clearAllMocks()
  deleteCalls.length = 0
  deleteResults = []
  timeline.length = 0
  rollupResults = []
  pruneResult = { data: 0, error: null }
})

describe('GET /api/events/cleanup/cron', () => {
  it('runs two delete passes: delivery at 30 days (telemetry excluded), everything at 180', async () => {
    deleteResults = [
      { error: null, count: 12 },
      { error: null, count: 3 },
    ]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))
    const json = await response.json()

    expect(json).toEqual({
      success: true,
      deleted: 15,
      deletedDelivery: 12,
      deletedTelemetry: 3,
      rolledUpDays: 0,
      prunedOutbox: 0,
    })

    expect(deleteCalls).toHaveLength(2)

    // Pass 1: 30-day cutoff + telemetry exclusion filters.
    const pass1 = deleteCalls[0]
    const lt1 = pass1.filters.find((f) => f.method === 'lt')!
    expect(lt1.args[0]).toBe('created_at')
    expect(daysAgo(lt1.args[1] as string)).toBeCloseTo(30, 0)
    const notFilters = pass1.filters.filter((f) => f.method === 'not')
    expect(notFilters.map((f) => f.args)).toEqual([
      ['event_type', 'like', 'mcp.%'],
      ['event_type', 'like', 'agent.%'],
    ])

    // Pass 2: 180-day cutoff, no exclusions, sweeps the telemetry rows.
    const pass2 = deleteCalls[1]
    const lt2 = pass2.filters.find((f) => f.method === 'lt')!
    expect(daysAgo(lt2.args[1] as string)).toBeCloseTo(180, 0)
    expect(pass2.filters.filter((f) => f.method === 'not')).toHaveLength(0)
  })

  it('rolls telemetry up one day per call from 181 days back, before the telemetry purge', async () => {
    rollupResults = [{ data: 1, error: null }, { data: 0, error: null }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toMatchObject({ success: true, rolledUpDays: 1 })
    expect(timeline).toEqual(['delete', 'rollup_agent_telemetry', 'rollup_agent_telemetry', 'delete', 'prune_event_outbox'])
    const args = rollupCalls()[0][1] as { p_since: string; p_max_days: number }
    expect(args.p_max_days).toBe(1)
    expect(daysAgo(args.p_since)).toBeCloseTo(181, 0)
  })

  it('catches up at most seven days a night', async () => {
    rollupResults = Array.from({ length: 10 }, () => ({ data: 1, error: null }))

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toMatchObject({ success: true, rolledUpDays: 7 })
    expect(rollupCalls()).toHaveLength(7)
    expect(deleteCalls).toHaveLength(2)
  })

  it('skips the telemetry purge and the outbox prune when the rollup fails', async () => {
    deleteResults = [{ error: null, count: 4 }]
    rollupResults = [{ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    // Only the delivery pass ran: no telemetry row was deleted uncounted.
    expect(timeline).toEqual(['delete', 'rollup_agent_telemetry'])
  })

  it('prunes the event outbox after the event_log passes', async () => {
    pruneResult = { data: 7, error: null }
    const response = await GET(createCronRequest('/api/events/cleanup/cron'))
    const json = await response.json()
    expect(rpc).toHaveBeenCalledWith('prune_event_outbox', undefined)
    expect(json).toMatchObject({ success: true, prunedOutbox: 7 })
  })

  it.each([
    ['not deployed yet', { code: 'PGRST202', message: 'Could not find the function public.prune_event_outbox' }],
    ['failing', { code: 'XX000', message: 'boom' }],
  ])('still answers the event_log cleanup when the outbox prune is %s', async (_label, error) => {
    deleteResults = [
      { error: null, count: 4 },
      { error: null, count: 1 },
    ]
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

  it('short-circuits with an error envelope when the delivery pass fails', async () => {
    deleteResults = [{ error: { message: 'boom', code: 'XX000' }, count: null }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    // The rollup, the 180-day pass and the outbox prune never ran.
    expect(deleteCalls).toHaveLength(1)
    expect(rpc).not.toHaveBeenCalled()
  })
})
