import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

// Mock session auth (requireAuth enforces MFA; returns the request-scoped client)
const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Mock API key auth
const mockValidateApiKey = vi.fn()
const mockExtractBearerToken = vi.fn()
const mockCreateServiceClientNoCookies = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
  extractBearerToken: (...args: unknown[]) => mockExtractBearerToken(...args),
  createServiceClientNoCookies: () => mockCreateServiceClientNoCookies(),
}))

import { GET } from '../route'

describe('GET /api/events', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  const sampleEvents = [
    {
      sequence: 1,
      event_type: 'invoice.created',
      entity_id: 'inv-1',
      data: { invoice: { id: 'inv-1', total: 1000 } },
      created_at: '2026-03-25T10:00:00Z',
    },
    {
      sequence: 2,
      event_type: 'customer.created',
      entity_id: 'cust-1',
      data: { customer: { id: 'cust-1', name: 'Acme AB' } },
      created_at: '2026-03-25T10:01:00Z',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockExtractBearerToken.mockReturnValue(null)
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    mockExtractBearerToken.mockReturnValue(null)
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns events with session auth', async () => {
    enqueue({ data: sampleEvents })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof sampleEvents
      cursor: number
      has_more: boolean
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.cursor).toBe(2)
    expect(body.has_more).toBe(false)
  })

  it('returns events with API key auth', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_test123')
    mockValidateApiKey.mockResolvedValue({ userId: 'user-1' })

    const apiKeySupabase = createQueuedMockSupabase()
    apiKeySupabase.enqueue({ data: sampleEvents })
    mockCreateServiceClientNoCookies.mockReturnValue(apiKeySupabase.supabase)

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof sampleEvents
      cursor: number
      has_more: boolean
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(mockValidateApiKey).toHaveBeenCalledWith('gnubok_sk_test123')
  })

  it('returns 401 for invalid API key', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_invalid')
    mockValidateApiKey.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Invalid API key' })
  })

  it('returns 429 for rate-limited API key', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_limited')
    mockValidateApiKey.mockResolvedValue({ error: 'Rate limit exceeded', status: 429 })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(429)
  })

  it('supports after cursor parameter', async () => {
    enqueue({ data: [sampleEvents[1]] })

    const request = createMockRequest('/api/events', {
      searchParams: { after: '1' },
    })
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof sampleEvents
      cursor: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.cursor).toBe(2)
  })

  it('supports types filter parameter', async () => {
    enqueue({ data: [sampleEvents[0]] })

    const request = createMockRequest('/api/events', {
      searchParams: { types: 'invoice.created' },
    })
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof sampleEvents
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('returns has_more=true when results equal limit', async () => {
    // Return exactly `limit` items to trigger has_more
    const events = Array.from({ length: 2 }, (_, i) => ({
      sequence: i + 1,
      event_type: 'invoice.created',
      entity_id: `inv-${i}`,
      data: {},
      created_at: '2026-03-25T10:00:00Z',
    }))
    enqueue({ data: events })

    const request = createMockRequest('/api/events', {
      searchParams: { limit: '2' },
    })
    const response = await GET(request)
    const { body } = await parseJsonResponse<{ has_more: boolean }>(response)

    expect(body.has_more).toBe(true)
  })

  it('returns cursor=0 when no events and no after param', async () => {
    enqueue({ data: [] })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { body } = await parseJsonResponse<{ cursor: number; data: unknown[] }>(response)

    expect(body.data).toHaveLength(0)
    expect(body.cursor).toBe(0)
  })

  it('returns cursor=after when no events but after param provided', async () => {
    enqueue({ data: [] })

    const request = createMockRequest('/api/events', {
      searchParams: { after: '42' },
    })
    const response = await GET(request)
    const { body } = await parseJsonResponse<{ cursor: number }>(response)

    expect(body.cursor).toBe(42)
  })

  it('rejects invalid limit parameter', async () => {
    const request = createMockRequest('/api/events', {
      searchParams: { limit: '999' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })
})
