import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

// Mock session auth (requireAuth enforces MFA; returns the request-scoped client)
const { supabase: mockSupabase, enqueue, reset, findCalls: findSessionCalls } = createQueuedMockSupabase()

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

// The multi-user seat gate's membership check (MULTI_USER_SEAT_GATE).
const mockIsMembershipActive = vi.fn()
vi.mock('@/lib/entitlements/multi-user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/multi-user')>()
  return {
    ...actual,
    isMembershipActive: (...args: unknown[]) => mockIsMembershipActive(...args),
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
    mockIsMembershipActive.mockResolvedValue(true)
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

  it('returns 403 for a non-owner key in a company paused by the multi-user seat gate, before reading events', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_frozen')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    mockIsMembershipActive.mockResolvedValue(false)
    const keyClient = withKeyClient([{ data: { company_id: 'company-1', role: 'member' } }, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mockIsMembershipActive).toHaveBeenCalledWith(keyClient.supabase, 'company-1', 'member')
    expect(keyClient.findCalls('event_log', 'select')).toEqual([])
  })

  it('returns 403 for a key whose membership has the invoicing-only role, before reading events', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_invoicer')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    const keyClient = withKeyClient([{ data: { company_id: 'company-1', role: 'invoicer' } }, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(keyClient.findCalls('event_log', 'select')).toEqual([])
  })

  it('serves an owner key through the seat gate check', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_owner')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    const keyClient = withKeyClient([{ data: { company_id: 'company-1', role: 'owner' } }, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))

    expect(response.status).toBe(200)
    expect(mockIsMembershipActive).toHaveBeenCalledWith(keyClient.supabase, 'company-1', 'owner')
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

  // ── Scoped event families need their scope on a key ─────────
  // Payroll events (salary_run.*, agi.*) need payroll:read; question list
  // events (company_question.*) need agent:read.

  it('withholds payroll events from a key without payroll:read', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ scopes: ['events:read', 'agent:read'] }))
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))

    expect(response.status).toBe(200)
    expect(keyClient.findCalls('event_log', 'not')).toEqual([
      ['event_type', 'like', 'salary_run.%'],
      ['event_type', 'like', 'agi.%'],
    ])
  })

  it('withholds question list events from a key without agent:read', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ scopes: ['events:read', 'payroll:read'] }))
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))

    expect(response.status).toBe(200)
    expect(keyClient.findCalls('event_log', 'not')).toEqual([['event_type', 'like', 'company_question.%']])
  })

  it('withholds both families from a key holding only events:read', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))

    expect(response.status).toBe(200)
    expect(keyClient.findCalls('event_log', 'not')).toEqual([
      ['event_type', 'like', 'salary_run.%'],
      ['event_type', 'like', 'agi.%'],
      ['event_type', 'like', 'company_question.%'],
    ])
  })

  it('serves payroll and question list events to a key holding payroll:read and agent:read', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ scopes: ['events:read', 'payroll:read', 'agent:read'] }))
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const response = await GET(createMockRequest('/api/events'))

    expect(response.status).toBe(200)
    expect(keyClient.findCalls('event_log', 'not')).toEqual([])
  })

  it('serves a question list event as stored: the question by id and its state', async () => {
    const stored = {
      sequence: 7,
      event_type: 'company_question.closed',
      entity_id: 'e0000000-0000-4000-8000-000000000001',
      data: {
        questionId: 'e0000000-0000-4000-8000-000000000001',
        status: 'closed',
        closeReason: 'dont_know',
        answeredVia: 'app',
        answeredAt: '2026-11-19T09:00:00.000Z',
      },
      created_at: '2026-11-19T09:00:01Z',
    }
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ scopes: ['events:read', 'agent:read'] }))
    const keyClient = withKeyClient([membershipFound, { data: [stored] }])

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'company_question.closed' } }),
    )
    const { status, body } = await parseJsonResponse<{ data: unknown[]; cursor: number }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([stored])
    expect(body.cursor).toBe(7)
    expect(keyClient.findCalls('event_log', 'in')).toEqual([['event_type', ['company_question.closed']]])
  })

  it('serves payroll and question list events to a session user', async () => {
    enqueue({ data: sampleEvents })

    const response = await GET(createMockRequest('/api/events'))

    expect(response.status).toBe(200)
    expect(findSessionCalls('event_log', 'select')).toHaveLength(1)
    expect(findSessionCalls('event_log', 'not')).toEqual([])
  })

  it('refuses a payroll type named in types without payroll:read, before reading events', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,salary_run.booked' } }),
    )
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details).toMatchObject({ required_scope: 'payroll:read' })
    expect(keyClient.findCalls('event_log', 'select')).toEqual([])
  })

  it('refuses a question list type named in types without agent:read, before reading events', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth({ scopes: ['events:read', 'payroll:read'] }))
    const keyClient = withKeyClient([membershipFound, { data: sampleEvents }])

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,company_question.answered' } }),
    )
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(403)
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(body.error.details).toMatchObject({
      required_scope: 'agent:read',
      reason: 'Reading company_question.answered requires agent:read in addition to events:read.',
    })
    expect(keyClient.findCalls('event_log', 'select')).toEqual([])
  })
})
