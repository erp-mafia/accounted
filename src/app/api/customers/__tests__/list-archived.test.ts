/**
 * GET /api/customers: the roster hides customers archived through the v1 API
 * (archived_at set). Archived rows stay in the table for BFL retention, so the
 * filter is the only thing keeping them out of the dashboard list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET } from '../route'

describe('GET /api/customers: archived rows', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await GET(createMockRequest('/api/customers'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('filters on archived_at IS NULL and still returns the active roster', async () => {
    const customers = [makeCustomer({ name: 'Beta AB' }), makeCustomer({ name: 'Alfa AB' })]
    enqueue({ data: customers, error: null })

    const response = await GET(createMockRequest('/api/customers'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: Array<{ name: string }> }>(response)

    expect(status).toBe(200)
    expect(body.data.map((c) => c.name)).toEqual(['Alfa AB', 'Beta AB'])
    expect(findCall('customers', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('customers', 'is')).toEqual(['archived_at', null])
  })
})
