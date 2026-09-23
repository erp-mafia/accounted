/**
 * GET /api/suppliers: the roster hides suppliers archived through the v1 API
 * (archived_at set, is_active=false). Archived rows stay in the table for BFL
 * retention, so the filter is the only thing keeping them out of the list and
 * the supplier-invoice picker that reads this route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeSupplier,
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

describe('GET /api/suppliers', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await GET(createMockRequest('/api/suppliers'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('lists suppliers for the active company', async () => {
    const suppliers = [makeSupplier({ name: 'Alfa AB' }), makeSupplier({ name: 'Beta AB' })]
    enqueue({ data: suppliers, error: null })

    const response = await GET(createMockRequest('/api/suppliers'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(suppliers)
    expect(findCall('suppliers', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('hides API-archived suppliers: filters on archived_at IS NULL', async () => {
    enqueue({ data: [], error: null })

    await GET(createMockRequest('/api/suppliers'), { params: Promise.resolve({}) })

    expect(findCall('suppliers', 'is')).toEqual(['archived_at', null])
  })

  it('returns the error envelope when the query fails', async () => {
    enqueue({ data: null, error: { message: 'boom', code: '42P01' } })

    const response = await GET(createMockRequest('/api/suppliers'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ error: unknown }>(response)

    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
  })
})
