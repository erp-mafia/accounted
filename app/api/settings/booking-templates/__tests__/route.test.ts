/**
 * Tests for GET /api/settings/booking-templates.
 *
 * Focused on the is_hidden decoration: every row carries the per-company flag,
 * a failed hidden lookup falls back to "nothing hidden" (showing extra
 * templates is the safe direction), and hidden rows are still RETURNED so the
 * settings panel can offer restore; filtering is the pickers' job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
  requireCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET } from '../route'

/** Chainable builder resolving queued {data,error} per from() in call order. */
function createQueuedSupabase(results: { data?: unknown; error?: unknown }[]) {
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'or', 'order', 'maybeSingle']) {
      b[m] = () => b
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null })
    return b
  }
  return { from: () => makeBuilder() }
}

const TEMPLATES = [
  { id: 'tpl-1', name: 'Bankavgift', is_system: true },
  { id: 'tpl-2', name: 'Eget uttag', is_system: true },
]

beforeEach(() => {
  vi.clearAllMocks()
})

function auth(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

const req = () => createMockRequest('/api/settings/booking-templates', { method: 'GET' })

describe('GET /api/settings/booking-templates', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(req(), { params: Promise.resolve({}) })).status).toBe(401)
  })

  it('marks hidden templates but still returns them', async () => {
    // from() order: companies, then library / usage / hidden.
    const supabase = createQueuedSupabase([
      { data: { team_id: null } },
      { data: TEMPLATES },
      { data: [] },
      { data: [{ template_id: 'tpl-2' }] },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{
      data: { id: string; is_hidden: boolean }[]
    }>(await GET(req(), { params: Promise.resolve({}) }))
    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data.find((t) => t.id === 'tpl-1')?.is_hidden).toBe(false)
    expect(body.data.find((t) => t.id === 'tpl-2')?.is_hidden).toBe(true)
  })

  it('falls back to nothing hidden when the hidden lookup fails', async () => {
    const supabase = createQueuedSupabase([
      { data: { team_id: null } },
      { data: TEMPLATES },
      { data: [] },
      { error: { message: 'boom' } },
    ])
    auth(supabase)
    const { status, body } = await parseJsonResponse<{
      data: { is_hidden: boolean }[]
    }>(await GET(req(), { params: Promise.resolve({}) }))
    expect(status).toBe(200)
    expect(body.data.every((t) => t.is_hidden === false)).toBe(true)
  })
})
