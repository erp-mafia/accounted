import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

describe('GET /api/invoices/recurring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(createMockRequest('/api/invoices/recurring'), { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)
    expect(status).toBe(401)
  })

  it('returns schedule list', async () => {
    const schedules = [
      { id: 's-1', name: 'Acme retainer', day_of_month: 15, status: 'active' },
    ]
    enqueue({ data: schedules, error: null })

    const response = await GET(createMockRequest('/api/invoices/recurring'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual(schedules)
  })
})

describe('POST /api/invoices/recurring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 400 on validation error (missing items)', async () => {
    const request = createMockRequest('/api/invoices/recurring', {
      method: 'POST',
      body: {
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test',
        day_of_month: 15,
        payment_terms_days: 30,
        currency: 'SEK',
        auto_send: false,
        items: [],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ type: string }>(response)
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
  })

  it('returns 404 when customer does not exist', async () => {
    enqueue({ data: null, error: null }) // customer lookup → null

    const request = createMockRequest('/api/invoices/recurring', {
      method: 'POST',
      body: {
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test',
        day_of_month: 15,
        payment_terms_days: 30,
        currency: 'SEK',
        auto_send: false,
        items: [
          { description: 'Service', quantity: 1, unit: 'st', unit_price: 1000 },
        ],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ type: string }>(response)
    expect(status).toBe(404)
    expect(body.type).toBe('not_found')
  })

  it('rejects auto_send when the customer has no email', async () => {
    // customer lookup: exists but without email
    enqueue({ data: { id: '550e8400-e29b-41d4-a716-446655440000', email: null }, error: null })

    const request = createMockRequest('/api/invoices/recurring', {
      method: 'POST',
      body: {
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test',
        day_of_month: 15,
        payment_terms_days: 30,
        currency: 'SEK',
        auto_send: true,
        items: [
          { description: 'Service', quantity: 1, unit: 'st', unit_price: 1000 },
        ],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ type: string }>(response)
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
  })

  it('creates a schedule on the happy path', async () => {
    const createdSchedule = {
      id: 's-1',
      company_id: 'company-1',
      user_id: 'user-1',
      customer_id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Acme retainer',
      day_of_month: 15,
      next_run_date: '2026-05-15',
      status: 'active',
    }
    // 1. customer lookup ok
    enqueue({ data: { id: '550e8400-e29b-41d4-a716-446655440000' }, error: null })
    // 2. schedule insert returns the row
    enqueue({ data: createdSchedule, error: null })
    // 3. items insert ok
    enqueue({ data: null, error: null })
    // 4. final re-fetch
    enqueue({ data: { ...createdSchedule, items: [] }, error: null })

    const request = createMockRequest('/api/invoices/recurring', {
      method: 'POST',
      body: {
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Acme retainer',
        day_of_month: 15,
        payment_terms_days: 30,
        currency: 'SEK',
        auto_send: false,
        items: [
          { description: 'Konsultarvode', quantity: 10, unit: 'tim', unit_price: 1200 },
        ],
      },
    })
    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)
    expect(status).toBe(201)
    expect(body.data.id).toBe('s-1')
  })
})
