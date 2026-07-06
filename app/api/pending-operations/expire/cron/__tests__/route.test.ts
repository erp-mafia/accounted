/**
 * Tests for the pending_operations expiry cron: stale (>30 days) pending
 * staged operations are auto-rejected with the commit dispatcher's
 * result_data shape ({ auto_rejected: true, reason: 'expired' }) so the
 * /pending UI can render them as "Utgick automatiskt".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

interface FilterCall {
  method: string
  args: unknown[]
}

interface UpdateCapture {
  payload: Record<string, unknown> | null
  filters: FilterCall[]
}

const updateCalls: UpdateCapture[] = []
let updateResults: Array<{ data: unknown; error: unknown }> = []

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => {
      const capture: UpdateCapture = { payload: null, filters: [] }
      updateCalls.push(capture)
      const result = updateResults.shift() ?? { data: [], error: null }
      const chain: Record<string, unknown> = {}
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        capture.payload = payload
        return chain
      })
      chain.eq = vi.fn((...args: unknown[]) => {
        capture.filters.push({ method: 'eq', args })
        return chain
      })
      chain.lt = vi.fn((...args: unknown[]) => {
        capture.filters.push({ method: 'lt', args })
        return chain
      })
      chain.select = vi.fn((...args: unknown[]) => {
        capture.filters.push({ method: 'select', args })
        return chain
      })
      // Thenable: awaiting the builder resolves the queued result.
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    }),
  })),
}))

import { GET } from '../route'
import { verifyCronSecret } from '@/lib/auth/cron'
import { createServiceClient } from '@/lib/supabase/server'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/pending-operations/expire/cron')
}

function daysAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000
}

beforeEach(() => {
  vi.clearAllMocks()
  updateCalls.length = 0
  updateResults = []
})

describe('GET /api/pending-operations/expire/cron', () => {
  it('flips stale pending rows to rejected with the auto-expired marker', async () => {
    updateResults = [
      { data: [{ id: 'op-1', company_id: 'c-1' }, { id: 'op-2', company_id: 'c-2' }], error: null },
    ]

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(json.success).toBe(true)
    expect(json.expired).toBe(2)
    expect(daysAgo(json.cutoff)).toBeCloseTo(30, 0)

    expect(updateCalls).toHaveLength(1)
    const call = updateCalls[0]

    // The update payload: terminal rejected status + the exact result_data
    // shape the commit dispatcher uses for its own auto-rejects, with the
    // strict 'expired' reason the UI badge keys on. rejection_category and
    // rejection_reason must NOT be set: those carry user-feedback semantics.
    expect(call.payload).toBeTruthy()
    expect(call.payload!.status).toBe('rejected')
    expect(Number.isNaN(new Date(call.payload!.resolved_at as string).getTime())).toBe(false)
    expect(call.payload!.result_data).toEqual({ auto_rejected: true, reason: 'expired' })
    expect(call.payload).not.toHaveProperty('rejection_category')
    expect(call.payload).not.toHaveProperty('rejection_reason')

    // CAS on status='pending' (skips concurrently-claimed 'committing' rows)
    // + the 30-day created_at cutoff.
    const eq = call.filters.find((f) => f.method === 'eq')!
    expect(eq.args).toEqual(['status', 'pending'])
    const lt = call.filters.find((f) => f.method === 'lt')!
    expect(lt.args[0]).toBe('created_at')
    expect(daysAgo(lt.args[1] as string)).toBeCloseTo(30, 0)
    // .select() must be chained: without it PostgREST returns no rows and
    // the endpoint would permanently report expired: 0.
    expect(call.filters.some((f) => f.method === 'select')).toBe(true)
  })

  it('reports zero when no rows are stale', async () => {
    updateResults = [{ data: [], error: null }]

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(json).toEqual({ success: true, expired: 0, cutoff: expect.any(String) })
  })

  it('returns 401 without touching the database when cron auth fails', async () => {
    vi.mocked(verifyCronSecret).mockReturnValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
  })

  it('returns an error envelope when the update fails', async () => {
    updateResults = [{ data: null, error: { message: 'boom', code: 'XX000' } }]

    const response = await GET(cronRequest())

    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
