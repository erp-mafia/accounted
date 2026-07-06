/**
 * Tests for the event_log cleanup cron's differentiated retention:
 * delivery events at 30 days, agent telemetry (mcp.*, agent.*) at 180 days.
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

const deleteCalls: DeleteCapture[] = []
let deleteResults: Array<{ error: unknown; count: number | null }> = []

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => {
      const capture: DeleteCapture = { filters: [] }
      deleteCalls.push(capture)
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

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/events/cleanup/cron')
}

function daysAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

beforeEach(() => {
  vi.clearAllMocks()
  deleteCalls.length = 0
  deleteResults = []
})

describe('GET /api/events/cleanup/cron', () => {
  it('runs two delete passes: delivery at 30 days (telemetry excluded), everything at 180', async () => {
    deleteResults = [
      { error: null, count: 12 },
      { error: null, count: 3 },
    ]

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(json).toEqual({
      success: true,
      deleted: 15,
      deletedDelivery: 12,
      deletedTelemetry: 3,
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

  it('short-circuits with an error envelope when the delivery pass fails', async () => {
    deleteResults = [{ error: { message: 'boom', code: 'XX000' }, count: null }]

    const response = await GET(cronRequest())

    expect(response.status).toBeGreaterThanOrEqual(500)
    // The 180-day pass never ran.
    expect(deleteCalls).toHaveLength(1)
  })
})
