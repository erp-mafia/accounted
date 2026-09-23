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

// Mock API key auth. Only the three IO-bound helpers are faked: hasScope and
// DEFAULT_SCOPES stay real so the scope tests exercise the actual scope table.
const mockValidateApiKey = vi.fn()
const mockExtractBearerToken = vi.fn()
const mockCreateServiceClientNoCookies = vi.fn()
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return {
    ...actual,
    validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
    extractBearerToken: (...args: unknown[]) => mockExtractBearerToken(...args),
    createServiceClientNoCookies: () => mockCreateServiceClientNoCookies(),
  }
})

import { DEFAULT_SCOPES } from '@/lib/auth/api-keys'
import { GET } from '../route'

interface ErrorEnvelope {
  error: { code: string; message: string; message_en?: string; details?: unknown }
}

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

  /** A successful validateApiKey result, scoped and live by default. */
  const apiKeyAuth = (overrides: Record<string, unknown> = {}) => ({
    userId: 'user-1',
    companyId: 'company-1',
    apiKeyId: 'key-1',
    apiKeyName: 'n8n poller',
    scopes: ['events:read'],
    mode: 'live',
    ...overrides,
  })

  /**
   * Wire the service-role client the API-key branch uses. The route makes at
   * most two queries in order: company_members, then event_log.
   */
  const withKeyClient = (
    results: { data?: unknown; error?: unknown }[],
  ) => {
    const keyClient = createQueuedMockSupabase()
    for (const r of results) keyClient.enqueue(r)
    mockCreateServiceClientNoCookies.mockReturnValue(keyClient.supabase)
    return keyClient
  }

  /** The membership row the re-check expects to find. */
  const membershipFound = { data: { company_id: 'company-1' } }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockExtractBearerToken.mockReturnValue(null)
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  // ── Session auth (unchanged behaviour) ───────────────────────

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
    // Exactly ONE queued result: if the session path wrongly ran the
    // company_members re-check it would consume this and return no events.
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
    expect(mockValidateApiKey).not.toHaveBeenCalled()
    expect(response.headers.get('X-Gnubok-Mode')).toBeNull()
  })

  // ── API key auth ─────────────────────────────────────────────

  it('returns events with API key auth', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_test123')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    withKeyClient([membershipFound, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: typeof sampleEvents
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
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(401)
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 429 with a RATE_LIMITED code for a rate-limited API key', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_limited')
    mockValidateApiKey.mockResolvedValue({ error: 'Rate limit exceeded', status: 429 })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(429)
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  // ── Guard 1: scope ───────────────────────────────────────────

  it('returns 403 INSUFFICIENT_SCOPE for a key without events:read', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_noscope')
    mockValidateApiKey.mockResolvedValue(
      apiKeyAuth({ scopes: ['reports:read', 'invoices:read'] }),
    )
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details).toMatchObject({ required_scope: 'events:read' })
    // Denied before any DB access.
    expect(keyClient.supabase.from).not.toHaveBeenCalled()
  })

  it('returns 403 for a legacy null-scope key falling back to DEFAULT_SCOPES', async () => {
    // validateApiKey substitutes DEFAULT_SCOPES when the api_keys row has
    // scopes = NULL. Those six read scopes do NOT include events:read.
    expect(DEFAULT_SCOPES).not.toContain('events:read')

    mockExtractBearerToken.mockReturnValue('gnubok_sk_legacy')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ scopes: DEFAULT_SCOPES }))
    withKeyClient([membershipFound, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  // ── Guard 2: company membership re-check ─────────────────────

  it('returns 404 when the key user is no longer a member of the bound company', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_offboarded')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    // Membership lookup finds nothing (offboarded, or company archived).
    withKeyClient([{ data: null }, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 500 when the membership lookup itself fails', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_dberror')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    withKeyClient([{ error: { message: 'connection failure' } }, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  // ── Guard 3: test-mode keys ──────────────────────────────────

  it('serves a test-mode key and labels the response X-Gnubok-Mode: test', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_test_abc')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ mode: 'test' }))
    withKeyClient([membershipFound, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: typeof sampleEvents }>(response)

    // A read has no write path to simulate, so it is served (matching every v1
    // read) rather than blocked with TEST_KEY_WRITE_BLOCKED.
    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(response.headers.get('X-Gnubok-Mode')).toBe('test')
  })

  it('does not label live-key responses with X-Gnubok-Mode', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_live')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ mode: 'live' }))
    withKeyClient([membershipFound, { data: sampleEvents }])

    const request = createMockRequest('/api/events')
    const response = await GET(request)

    expect(response.headers.get('X-Gnubok-Mode')).toBeNull()
  })

  // ── Payload minimisation ─────────────────────────────────────

  it('minimises event payloads before returning them', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    withKeyClient([
      membershipFound,
      {
        data: [
          {
            sequence: 7,
            event_type: 'invoice.created',
            entity_id: 'inv-7',
            // userId is what minimisePayload strips: an internal
            // auth.users.id that identifies the gnubok-side actor.
            data: { userId: 'user-1', invoice: { id: 'inv-7', total: 1250 } },
            created_at: '2026-03-25T10:00:00Z',
          },
        ],
      },
    ])

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: { data: Record<string, unknown> }[]
    }>(response)

    expect(status).toBe(200)
    expect(body.data[0].data).not.toHaveProperty('userId')
    expect(body.data[0].data).toHaveProperty('invoice')
  })

  it('leaves non-object payloads untouched', async () => {
    enqueue({
      data: [
        {
          sequence: 3,
          event_type: 'period.locked',
          entity_id: null,
          data: null,
          created_at: '2026-03-25T10:00:00Z',
        },
      ],
    })

    const request = createMockRequest('/api/events')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: { data: unknown }[] }>(response)

    expect(status).toBe(200)
    expect(body.data[0].data).toBeNull()
  })

  // ── Query params + cursor semantics ──────────────────────────

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

  it('rejects invalid query params before running the event query for API keys', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    withKeyClient([membershipFound, { data: sampleEvents }])

    const request = createMockRequest('/api/events', {
      searchParams: { after: '-1' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })
})
