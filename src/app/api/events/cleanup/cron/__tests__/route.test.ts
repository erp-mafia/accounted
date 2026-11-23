/**
 * Tests for the event_log cleanup cron: roll agent telemetry into the
 * anonymous daily tables first (rollup_agent_telemetry), then delete agent
 * telemetry (mcp.*, agent.*) past 180 days, only after a rollup that
 * succeeded. Event data is kept: no business event, outbox row or delivery
 * is deleted (prune_delivery_events and prune_event_outbox are never called).
 * The purge over real PostgREST: tests/tool-pg/events-cleanup.tool.test.ts.
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
  table: string
  filters: FilterCall[]
}

type RpcResult = { data: unknown; error: unknown }

const deleteCalls: DeleteCapture[] = []
let deleteResults: Array<{ error: unknown; count: number | null }> = []
// Runs when a delete is awaited, before it answers (a slow delete moves the clock).
let onDelete: (() => void) | null = null
// What happened, in order: 'delete' per event_log delete, the RPC name per call.
const timeline: string[] = []
let rollupResults: RpcResult[] = []
function defaultRpc(name: string, _args?: unknown): Promise<RpcResult> {
  timeline.push(name)
  if (name === 'rollup_agent_telemetry') return Promise.resolve(rollupResults.shift() ?? { data: 0, error: null })
  return Promise.resolve({ data: 0, error: null })
}
const rpc = vi.fn(defaultRpc)

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    rpc: (name: string, args?: unknown) => rpc(name, args),
    from: vi.fn((table: string) => {
      const capture: DeleteCapture = { table, filters: [] }
      deleteCalls.push(capture)
      const chain: Record<string, unknown> = {}
      chain.delete = vi.fn(() => chain)
      for (const method of ['gte', 'lt', 'like', 'not', 'eq', 'or', 'in']) {
        chain[method] = vi.fn((...args: unknown[]) => {
          capture.filters.push({ method, args })
          return chain
        })
      }
      // Thenable: awaiting the builder runs the delete and resolves the queued result.
      chain.then = (resolve: (v: unknown) => unknown) => {
        timeline.push('delete')
        onDelete?.()
        return Promise.resolve(deleteResults.shift() ?? { error: null, count: 0 }).then(resolve)
      }
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

function filtersOf(capture: DeleteCapture): Array<[string, ...unknown[]]> {
  return capture.filters.map((f) => [f.method, ...f.args])
}

beforeEach(() => {
  vi.clearAllMocks()
  deleteCalls.length = 0
  deleteResults = []
  onDelete = null
  timeline.length = 0
  rollupResults = []
  rpc.mockImplementation(defaultRpc)
})

describe('GET /api/events/cleanup/cron', () => {
  it('rolls up, then deletes mcp.* and agent.* telemetry past 180 days and nothing else', async () => {
    rollupResults = [{ data: 1, error: null }, { data: 0, error: null }]
    deleteResults = [{ error: null, count: 3 }, { error: null, count: 1 }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toEqual({ success: true, deletedTelemetry: 4, rolledUpDays: 1 })
    expect(timeline).toEqual(['rollup_agent_telemetry', 'rollup_agent_telemetry', 'delete', 'delete'])

    const rollup = callsTo('rollup_agent_telemetry')[0][1] as { p_since: string; p_max_days: number }
    expect(rollup.p_max_days).toBe(1)
    expect(daysAgo(rollup.p_since)).toBeCloseTo(181, 0)

    // Each delete is held to one telemetry prefix and to the 180-day cutoff.
    expect(deleteCalls.map((c) => c.table)).toEqual(['event_log', 'event_log'])
    const [mcp, agent] = deleteCalls.map(filtersOf)
    expect(mcp.slice(0, 3)).toEqual([
      ['gte', 'event_type', 'mcp'],
      ['lt', 'event_type', 'mcq'],
      ['like', 'event_type', 'mcp.%'],
    ])
    expect(agent.slice(0, 3)).toEqual([
      ['gte', 'event_type', 'agent'],
      ['lt', 'event_type', 'agenu'],
      ['like', 'event_type', 'agent.%'],
    ])
    for (const filters of [mcp, agent]) {
      expect(filters).toHaveLength(4)
      const [method, column, cutoff] = filters[3]
      expect([method, column]).toEqual(['lt', 'created_at'])
      expect(daysAgo(cutoff as string)).toBeCloseTo(180, 0)
    }
  })

  it('never calls the business-event or outbox prunes', async () => {
    rollupResults = [{ data: 1, error: null }, { data: 0, error: null }]

    await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['rollup_agent_telemetry', 'rollup_agent_telemetry'])
    expect(callsTo('prune_delivery_events')).toHaveLength(0)
    expect(callsTo('prune_event_outbox')).toHaveLength(0)
  })

  it('catches up at most seven telemetry days a night', async () => {
    rollupResults = Array.from({ length: 10 }, () => ({ data: 1, error: null }))

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(await response.json()).toMatchObject({ success: true, rolledUpDays: 7 })
    expect(callsTo('rollup_agent_telemetry')).toHaveLength(7)
  })

  it('skips the telemetry purge when the rollup fails, and answers with an error', async () => {
    rollupResults = [{ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    // No telemetry row was deleted uncounted.
    expect(timeline).toEqual(['rollup_agent_telemetry'])
    expect(deleteCalls).toHaveLength(0)
  })

  it('still purges the other prefix when one delete fails, and answers with an error', async () => {
    deleteResults = [{ error: { message: 'boom', code: 'XX000' }, count: null }, { error: null, count: 2 }]

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(timeline).toEqual(['rollup_agent_telemetry', 'delete', 'delete'])
  })

  it('starts no rollup after 250 s, names it for the next run and purges nothing uncounted', async () => {
    // Every rollup counts a day and takes 60 s: the sixth would start at 300 s.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      rpc.mockImplementation((name: string) => {
        timeline.push(name)
        vi.setSystemTime(new Date(Date.now() + 60_000))
        return Promise.resolve({ data: 1, error: null })
      })

      const response = await GET(createCronRequest('/api/events/cleanup/cron'))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        success: true,
        deletedTelemetry: 0,
        rolledUpDays: 5,
        deferred: ['rollup'],
      })
      expect(timeline).toEqual(Array(5).fill('rollup_agent_telemetry'))
      expect(deleteCalls).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts no delete after 250 s and names the purge for the next run', async () => {
    // The first delete takes 260 s: the second would start past the budget.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      deleteResults = [{ error: null, count: 6 }]
      onDelete = () => vi.setSystemTime(new Date(Date.now() + 260_000))

      const response = await GET(createCronRequest('/api/events/cleanup/cron'))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        success: true,
        deletedTelemetry: 6,
        rolledUpDays: 0,
        deferred: ['telemetry_purge'],
      })
      expect(timeline).toEqual(['rollup_agent_telemetry', 'delete'])
    } finally {
      vi.useRealTimers()
    }
  })
})
