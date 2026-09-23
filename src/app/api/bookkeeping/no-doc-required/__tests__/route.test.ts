/**
 * Tests for GET /api/bookkeeping/no-doc-required — the exemption-set list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const routeParams = { params: Promise.resolve({}) }

function createCapturingSupabase(results: { data?: unknown; error?: unknown }[]) {
  const calls: { method: string; args: unknown[] }[] = []
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'order', 'range']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return b
      }
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null, count: null })
    return b
  }
  return { supabase: { from: () => makeBuilder() }, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/bookkeeping/no-doc-required', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/bookkeeping/no-doc-required'), routeParams)
    expect(res.status).toBe(401)
  })

  it('lists exemptions with a stable paging order', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ journal_entry_id: 'e1', reason: 'SIE-import' }] },
    ])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await GET(createMockRequest('/api/bookkeeping/no-doc-required'), routeParams)
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    // Paging-stability regression guard (fetch-all.ts ordering invariant).
    expect(calls.filter((c) => c.method === 'order').map((c) => c.args[0])).toContain(
      'journal_entry_id'
    )
  })
})
