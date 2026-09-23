/**
 * Tests for /api/calendar/feed/[token] (public ICS serve route).
 *
 * The membership check matters most: the token is the only authentication,
 * so removal from company_members must stop the feed. Without the check an
 * offboarded consultant's subscribed calendar keeps receiving the company's
 * deadlines and invoice details indefinitely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: () => supabase,
}))

import { GET } from '../route'

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
    enqueue({ data: null }) // company_members lookup: offboarded
    const [req, ctx] = tokenRequest('22222222-2222-2222-2222-222222222222')
    const res = await GET(req, ctx)
    expect(res.status).toBe(404)
  })

  it('serves an ICS calendar while the creator is still a member', async () => {
    enqueue({ data: FEED }) // calendar_feeds lookup
    enqueue({ data: { user_id: 'user-1' } }) // company_members lookup
    enqueue({ data: null }) // access tracking update
    enqueue({ data: [] }) // deadlines page 1 (empty: pagination stops)
    const [req, ctx] = tokenRequest('33333333-3333-3333-3333-333333333333')
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/calendar')
    expect(await res.text()).toContain('BEGIN:VCALENDAR')
  })
})
