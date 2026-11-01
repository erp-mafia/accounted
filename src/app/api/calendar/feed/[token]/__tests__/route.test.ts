/**
 * Tests for /api/calendar/feed/[token] (public ICS serve route).
 *
 * The membership check matters most: the token is the only authentication,
 * so removal from company_members, and archiving the company, must stop the
 * feed. Without the check an offboarded consultant's subscribed calendar keeps
 * receiving the company's deadlines and invoice details indefinitely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => supabase,
}))

import { GET } from '../route'

const MEMBERSHIP = { company_id: 'company-1', role: 'member', companies: { archived_at: null, name: 'Bolaget AB' } }

const FEED = {
  id: 'feed-1',
  company_id: 'company-1',
  user_id: 'user-1',
  is_active: true,
  expires_at: null,
  access_count: 0,
  include_tax_deadlines: true,
  include_invoices: false,
}

function tokenRequest(token: string) {
  return [
    new Request(`http://localhost/api/calendar/feed/${token}`),
    { params: Promise.resolve({ token }) },
  ] as const
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
})

describe('GET /api/calendar/feed/[token]', () => {
  it('returns 400 for a non-UUID token', async () => {
    const [req, ctx] = tokenRequest('not-a-uuid')
    const res = await GET(req, ctx)
    expect(res.status).toBe(400)
  })

  it('returns 404 when no active feed matches the token', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const [req, ctx] = tokenRequest('11111111-1111-1111-1111-111111111111')
    const res = await GET(req, ctx)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the feed creator is no longer a company member', async () => {
    enqueue({ data: FEED }) // calendar_feeds lookup
    enqueue({ data: null }) // company_members lookup: offboarded, or archived
    const [req, ctx] = tokenRequest('22222222-2222-2222-2222-222222222222')
    const res = await GET(req, ctx)
    expect(res.status).toBe(404)
  })

  it('asks through the one live-membership read, so an archived company reads as no member', async () => {
    enqueue({ data: FEED }) // calendar_feeds lookup
    enqueue({ data: null }) // the archived filter leaves no row
    const [req, ctx] = tokenRequest('11111111-1111-1111-1111-111111111111')
    const res = await GET(req, ctx)
    expect(res.status).toBe(404)
    expect(findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])
    expect(findCalls('company_members', 'eq')).toEqual(
      expect.arrayContaining([
        ['user_id', 'user-1'],
        ['company_id', 'company-1'],
      ]),
    )
  })

  it('answers 500, not "feed gone", when the membership could not be read', async () => {
    enqueue({ data: FEED }) // calendar_feeds lookup
    enqueue({ data: null, error: { message: 'connection reset' } })
    const [req, ctx] = tokenRequest('11111111-1111-1111-1111-111111111111')
    const res = await GET(req, ctx)
    expect(res.status).toBe(500)
  })

  it('serves an ICS calendar while the creator is still a member', async () => {
    enqueue({ data: FEED }) // calendar_feeds lookup
    enqueue({ data: MEMBERSHIP }) // company_members lookup
    enqueue({ data: null }) // access tracking update
    enqueue({ data: [] }) // deadlines page 1 (empty: pagination stops)
    const [req, ctx] = tokenRequest('33333333-3333-3333-3333-333333333333')
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/calendar')
    expect(await res.text()).toContain('BEGIN:VCALENDAR')
  })
})

/*
 * accounted#18: the window is counted from the Swedish calendar day. 23:30
 * UTC is already the next day in Stockholm, in summer (UTC+2) and in winter
 * (UTC+1).
 */
describe('GET /api/calendar/feed/[token]: invoices', () => {
  it('lists real invoices only: never a credit note, whatever its status (crm#1435)', async () => {
    enqueue({ data: { ...FEED, include_invoices: true } }) // calendar_feeds lookup
    enqueue({ data: MEMBERSHIP }) // company_members lookup
    enqueue({ data: null }) // access tracking update
    enqueue({ data: [] }) // deadlines page 1
    enqueue({ data: [] }) // invoices page 1
    const [req, ctx] = tokenRequest('66666666-6666-6666-6666-666666666666')
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(findCalls('invoices', 'eq')).toContainEqual(['document_type', 'invoice'])
    expect(findCalls('invoices', 'is')).toEqual([['credited_invoice_id', null]])
  })
})

describe('GET /api/calendar/feed/[token]: window from the Swedish day', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-04-02', '2027-07-02', '44444444-4444-4444-4444-444444444444'],
    ['winter', '2026-01-15T23:30:00Z', '2025-10-16', '2027-01-16', '55555555-5555-5555-5555-555555555555'],
  ])('%s: at %s the feed covers %s to %s', async (_season, instant, start, end, token) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    enqueue({ data: FEED }) // calendar_feeds lookup
    enqueue({ data: MEMBERSHIP }) // company_members lookup
    enqueue({ data: null }) // access tracking update
    enqueue({ data: [] }) // deadlines page 1
    const [req, ctx] = tokenRequest(token)
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(findCalls('deadlines', 'gte')).toEqual([['due_date', start]])
    expect(findCalls('deadlines', 'lte')).toEqual([['due_date', end]])
  })
})
