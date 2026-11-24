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
   * Wire the service-role client the API-key branch uses. The route queries
   * in order: company_members, then event_log (one read without types; with
   * types the reads of readEventPage).
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
    // The type's sequences, then the page's rows.
    enqueue({ data: [{ sequence: 1 }] })
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

  // ── Types filter: one read per type (crm#2142) ───────────────
  // An equality on event_type is one ordered range of
  // idx_event_log_company_type_sequence; `in` (event_type = ANY) is not, and
  // the planner walked the whole company log instead. Per type the read
  // takes sequences only; the page's rows come in one read by sequence.

  const EVENT_COLUMNS = 'sequence, event_type, entity_id, data, created_at'

  /** An event row of `type` at `sequence`. */
  const eventAt = (sequence: number, type: string) => ({
    sequence,
    event_type: type,
    entity_id: null,
    data: {},
    created_at: '2026-11-23T10:00:00Z',
  })

  /** A read of sequences only. */
  const seqs = (...sequences: number[]) => ({ data: sequences.map((sequence) => ({ sequence })) })

  it('reads one named type with an equality on event_type, sequences first, never in on the type', async () => {
    enqueue(seqs(3))
    enqueue({ data: [eventAt(3, 'journal_entry.committed')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'journal_entry.committed', after: '1' } }),
    )
    const { status, body } = await parseJsonResponse<{ data: { sequence: number }[]; cursor: number }>(response)

    expect(status).toBe(200)
    expect(body.data.map((e) => e.sequence)).toEqual([3])
    expect(body.cursor).toBe(3)
    // One type is one snapshot: no horizon read.
    expect(findSessionCalls('event_log', 'select')).toEqual([['sequence'], [EVENT_COLUMNS]])
    expect(findSessionCalls('event_log', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['event_type', 'journal_entry.committed'],
      ['company_id', 'company-1'],
    ])
    expect(findSessionCalls('event_log', 'gt')).toEqual([['sequence', 1]])
    expect(findSessionCalls('event_log', 'lte')).toEqual([])
    expect(findSessionCalls('event_log', 'in')).toEqual([['sequence', [3]]])
  })

  it('reads each named type on its own up to the horizon and merges the pages in sequence order', async () => {
    enqueue(seqs(9)) // the company's newest sequence
    enqueue(seqs(1, 4, 6)) // invoice.created
    enqueue(seqs(2, 3, 9)) // customer.created
    enqueue({ data: [eventAt(1, 'invoice.created'), eventAt(2, 'customer.created'), eventAt(3, 'customer.created')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.created,customer.created', limit: '3' } }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { sequence: number; event_type: string }[]
      cursor: number
      has_more: boolean
    }>(response)

    expect(status).toBe(200)
    expect(body.data.map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(body.cursor).toBe(3)
    expect(body.has_more).toBe(true)
    expect(findSessionCalls('event_log', 'order')).toContainEqual(['sequence', { ascending: false }])
    expect(findSessionCalls('event_log', 'eq').filter(([column]) => column === 'event_type')).toEqual([
      ['event_type', 'invoice.created'],
      ['event_type', 'customer.created'],
    ])
    // Every type read is bounded by the horizon and by one page.
    expect(findSessionCalls('event_log', 'lte')).toEqual([
      ['sequence', 9],
      ['sequence', 9],
    ])
    expect(findSessionCalls('event_log', 'limit')).toEqual([[1], [3], [3]])
    // The page's rows: the first three sequences of the merge.
    expect(findSessionCalls('event_log', 'in')).toEqual([['sequence', [1, 2, 3]]])
  })

  it('keeps the cursor on every type read', async () => {
    enqueue(seqs(20))
    enqueue(seqs(11))
    enqueue(seqs(12))
    enqueue({ data: [eventAt(11, 'invoice.paid'), eventAt(12, 'invoice.sent')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent', after: '10' } }),
    )

    expect(response.status).toBe(200)
    expect(findSessionCalls('event_log', 'gt')).toEqual([
      ['sequence', 10],
      ['sequence', 10],
    ])
  })

  it('answers a short merged page with has_more false and the last sequence as cursor', async () => {
    enqueue(seqs(5))
    enqueue(seqs(5))
    enqueue(seqs(2))
    enqueue({ data: [eventAt(2, 'invoice.sent'), eventAt(5, 'invoice.paid')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent' } }),
    )
    const { body } = await parseJsonResponse<{ data: { sequence: number }[]; cursor: number; has_more: boolean }>(
      response,
    )

    expect(body.data.map((e) => e.sequence)).toEqual([2, 5])
    expect(body.cursor).toBe(5)
    expect(body.has_more).toBe(false)
    expect(findSessionCalls('event_log', 'in')).toEqual([['sequence', [2, 5]]])
  })

  it('reads nothing more when the company has no event past the cursor', async () => {
    enqueue(seqs(42))

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent', after: '42' } }),
    )
    const { body } = await parseJsonResponse<{ data: unknown[]; cursor: number; has_more: boolean }>(response)

    expect(body).toEqual({ data: [], cursor: 42, has_more: false })
    expect(findSessionCalls('event_log', 'select')).toHaveLength(1)
  })

  it('answers an empty page for a company without events', async () => {
    enqueue({ data: [] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent' } }),
    )
    const { body } = await parseJsonResponse<{ data: unknown[]; cursor: number }>(response)

    expect(body.data).toEqual([])
    expect(body.cursor).toBe(0)
    expect(findSessionCalls('event_log', 'select')).toHaveLength(1)
  })

  it('reads a type named twice once', async () => {
    enqueue(seqs(1))
    enqueue({ data: [eventAt(1, 'invoice.created')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.created, invoice.created' } }),
    )
    const { body } = await parseJsonResponse<{ data: { sequence: number }[] }>(response)

    expect(body.data.map((e) => e.sequence)).toEqual([1])
    expect(findSessionCalls('event_log', 'eq').filter(([column]) => column === 'event_type')).toEqual([
      ['event_type', 'invoice.created'],
    ])
  })

  it('reads a repeated type among several once', async () => {
    enqueue(seqs(3))
    enqueue(seqs(1))
    enqueue(seqs(3))
    enqueue({ data: [eventAt(1, 'invoice.paid'), eventAt(3, 'invoice.sent')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent,invoice.paid' } }),
    )

    expect(response.status).toBe(200)
    expect(findSessionCalls('event_log', 'eq').filter(([column]) => column === 'event_type')).toEqual([
      ['event_type', 'invoice.paid'],
      ['event_type', 'invoice.sent'],
    ])
  })

  it('reads more types than run at once, and merges all of them', async () => {
    const six = ['a.one', 'b.two', 'c.three', 'd.four', 'e.five', 'f.six']
    enqueue(seqs(60))
    six.forEach((_, i) => enqueue(seqs(60 - i * 10)))
    enqueue({ data: [10, 20, 30, 40, 50, 60].map((n, i) => eventAt(n, six[5 - i])) })

    const response = await GET(createMockRequest('/api/events', { searchParams: { types: six.join(',') } }))
    const { body } = await parseJsonResponse<{ data: { sequence: number }[] }>(response)

    expect(body.data.map((e) => e.sequence)).toEqual([10, 20, 30, 40, 50, 60])
    expect(findSessionCalls('event_log', 'eq').filter(([column]) => column === 'event_type')).toEqual(
      six.map((type) => ['event_type', type]),
    )
    expect(findSessionCalls('event_log', 'in')).toEqual([['sequence', [10, 20, 30, 40, 50, 60]]])
  })

  it('withholds the closed families on every type read of a key and on the page read', async () => {
    mockExtractBearerToken.mockReturnValue('gnubok_sk_ok')
    mockValidateApiKey.mockResolvedValue(apiKeyAuth())
    const keyClient = withKeyClient([
      membershipFound,
      seqs(2),
      seqs(2),
      seqs(1),
      { data: [eventAt(1, 'invoice.sent'), eventAt(2, 'invoice.paid')] },
    ])

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent' } }),
    )
    const { status, body } = await parseJsonResponse<{ data: { sequence: number }[] }>(response)

    expect(status).toBe(200)
    expect(body.data.map((e) => e.sequence)).toEqual([1, 2])
    // Three families' prefixes on the two type reads and the page read.
    expect(keyClient.findCalls('event_log', 'not')).toHaveLength(9)
  })

  it('answers 500 when the read of one type fails, and starts no read after it', async () => {
    const six = ['a.one', 'b.two', 'c.three', 'd.four', 'e.five', 'f.six']
    enqueue(seqs(60))
    enqueue({ error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    const response = await GET(createMockRequest('/api/events', { searchParams: { types: six.join(',') } }))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    // The horizon and the four reads already running; not the last two types,
    // and no page read.
    expect(findSessionCalls('event_log', 'select')).toHaveLength(5)
  })

  it('answers 500 when the horizon read fails, before any type read', async () => {
    enqueue({ error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid,invoice.sent' } }),
    )
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(findSessionCalls('event_log', 'select')).toHaveLength(1)
  })

  it('answers 500 when the page read fails', async () => {
    enqueue(seqs(4))
    enqueue({ error: { message: 'connection reset', code: '08006' } })

    const response = await GET(createMockRequest('/api/events', { searchParams: { types: 'invoice.paid' } }))
    const { status, body } = await parseJsonResponse<ErrorEnvelope>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  it('answers the rows the page read finds when one went between the reads', async () => {
    // Sequence 2 went after the type read (its company was deleted).
    enqueue(seqs(1, 2, 3))
    enqueue({ data: [eventAt(1, 'invoice.paid'), eventAt(3, 'invoice.paid')] })

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'invoice.paid', limit: '3' } }),
    )
    const { body } = await parseJsonResponse<{ data: { sequence: number }[]; cursor: number; has_more: boolean }>(
      response,
    )

    expect(body.data.map((e) => e.sequence)).toEqual([1, 3])
    expect(body.cursor).toBe(3)
    expect(body.has_more).toBe(false)
  })

  it('reads each of up to a hundred types with a read of its own', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `custom.type_${i}`)
    enqueue(seqs(1))

    const response = await GET(createMockRequest('/api/events', { searchParams: { types: hundred.join(',') } }))

    expect(response.status).toBe(200)
    expect(findSessionCalls('event_log', 'eq').filter(([column]) => column === 'event_type')).toHaveLength(100)
    expect(findSessionCalls('event_log', 'in')).toEqual([])
  })

  it('reads more types than there are event types in one query with in', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `custom.type_${i}`)
    enqueue({ data: [eventAt(1, 'custom.type_0')] })

    const response = await GET(createMockRequest('/api/events', { searchParams: { types: many.join(',') } }))

    expect(response.status).toBe(200)
    expect(findSessionCalls('event_log', 'select')).toHaveLength(1)
    expect(findSessionCalls('event_log', 'in')).toEqual([['event_type', many]])
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
    const keyClient = withKeyClient([membershipFound, { data: [{ sequence: 7 }] }, { data: [stored] }])

    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types: 'company_question.closed' } }),
    )
    const { status, body } = await parseJsonResponse<{ data: unknown[]; cursor: number }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([stored])
    expect(body.cursor).toBe(7)
    expect(keyClient.findCalls('event_log', 'eq')).toContainEqual(['event_type', 'company_question.closed'])
    expect(keyClient.findCalls('event_log', 'in')).toEqual([['sequence', [7]]])
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
