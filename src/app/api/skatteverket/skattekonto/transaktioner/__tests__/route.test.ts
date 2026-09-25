import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The two enrichments read journal entries and the chart; they have their own
// suites. Stubbed here so this test is about the read path and the envelope.
vi.mock('@/lib/skatteverket/skattekonto-match', () => ({
  findMatchSuggestionsBulk: vi.fn().mockResolvedValue(new Map()),
}))
vi.mock('@/lib/skatteverket/skattekonto-booking', () => ({
  attachBookingSuggestions: vi.fn().mockImplementation((_s: unknown, _c: unknown, rows: unknown) => rows),
}))

import { GET } from '../route'

const row = (over: Record<string, unknown> = {}) => ({
  id: 'tx-1',
  company_id: 'company-1',
  transaktionsdatum: '2026-02-12',
  transaktionstext: 'Debiterad preliminärskatt',
  belopp_skatteverket: -1260,
  forfallodatum: null,
  journal_entry_id: null,
  is_ignored: false,
  status: 'booked',
  source: 'file_import',
  ...over,
})

describe('GET /api/skatteverket/skattekonto/transaktioner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' },
      supabase: mockSupabase,
      error: null,
    })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/skatteverket/skattekonto/transaktioner'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  // The point of the route: these rows arrive from a file import, with no
  // Skatteverket connection anywhere, so reading them must not depend on the
  // extension being switched on.
  it('returns the imported rows bucketed, without touching the extension', async () => {
    enqueue({ data: [row()], error: null })
    const res = await GET(createMockRequest('/api/skatteverket/skattekonto/transaktioner'))
    const { status, body } = await parseJsonResponse<{
      data: { booked: unknown[]; overdue: unknown[]; upcoming: unknown[]; ignored_count: number }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.booked).toHaveLength(1)
    expect(body.data.ignored_count).toBe(0)
    expect(body.data).not.toHaveProperty('ignored')
  })

  it('includes the ignored rows only when asked', async () => {
    enqueue({ data: [row({ id: 'tx-2', is_ignored: true })], error: null })
    const res = await GET(
      createMockRequest('/api/skatteverket/skattekonto/transaktioner?include_ignored=1'),
    )
    const { body } = await parseJsonResponse<{
      data: { ignored_count: number; ignored?: unknown[] }
    }>(res)

    expect(body.data.ignored_count).toBe(1)
    expect(body.data.ignored).toHaveLength(1)
  })

  it('maps a database failure through the canonical envelope, never raw', async () => {
    enqueue({ data: null, error: { message: 'relation "skattekonto_transactions" does not exist', code: '42P01' } })
    const res = await GET(createMockRequest('/api/skatteverket/skattekonto/transaktioner'))
    const { status, body } = await parseJsonResponse<{ error?: unknown }>(res)

    expect(status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(body)).not.toContain('does not exist')
  })
})
