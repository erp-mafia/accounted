import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('GET /api/supplier-invoices/exists', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: VALID_UUID, number: 'F-2026-881' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when supplier_id is not a uuid', async () => {
    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: 'not-a-uuid', number: 'F-2026-881' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ type: string }>(response)

    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
  })

  it('returns 400 when number is missing', async () => {
    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: VALID_UUID },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ type: string }>(response)

    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
  })

  it('returns exists: false when no matching invoice', async () => {
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: VALID_UUID, number: 'F-2026-881' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { exists: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ exists: false })
  })

  it('returns exists: true with the existing invoice details', async () => {
    const existing = { id: 'si-1', supplier_invoice_number: 'F-2026-881', status: 'approved' }
    enqueue({ data: existing, error: null })

    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: VALID_UUID, number: 'F-2026-881' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: { exists: boolean; existing: typeof existing }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ exists: true, existing })
  })

  it('mirrors the partial unique index predicate: excludes credited/reversed', async () => {
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: VALID_UUID, number: 'F-2026-881' },
    })
    await GET(request, { params: Promise.resolve({}) })

    expect(findCall('supplier_invoices', 'not')).toEqual([
      'status',
      'in',
      '(credited,reversed)',
    ])
    expect(findCall('supplier_invoices', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('returns 500 on database error', async () => {
    enqueue({ data: null, error: { message: 'DB error' } })

    const request = createMockRequest('/api/supplier-invoices/exists', {
      searchParams: { supplier_id: VALID_UUID, number: 'F-2026-881' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })
})
