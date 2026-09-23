import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const noParams = { params: Promise.resolve({}) }

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  // Local date parts, not toISOString(): UTC conversion would shift the day
  // in timezones ahead of UTC and skew the urgency math under test.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('GET /api/clients', () => {
  it('returns 401 when unauthenticated', async () => {
    unauthed()
    const res = await GET(createMockRequest('/api/clients'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 403 for a user without a byrå team', async () => {
    authed()
    // Query 1: byrå team membership lookup: no rows.
    enqueue({ data: [] })

    const res = await GET(createMockRequest('/api/clients'), noParams)
    const { status, body } = await parseJsonResponse<{
      error: { code: string }
    }>(res)

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('aggregates one urgency-sorted row per client company', async () => {
    authed()
    // 1. byrå membership
    enqueue({
      data: [
        {
          team_id: 'team-1',
          role: 'admin',
          teams: { id: 'team-1', name: 'Siffra', kind: 'byra' },
        },
      ],
    })
    // 2. client companies
    enqueue({
      data: [
        { id: 'c1', name: 'Alpha AB', org_number: '5560125790' },
        { id: 'c2', name: 'Beta AB', org_number: null },
      ],
    })
    // 3. company_settings (display names)
    enqueue({
      data: [{ company_id: 'c1', company_name: 'Alpha Redovisning AB', org_number: null }],
    })
    // 4. unbooked transactions (canonical predicate)
    enqueue({
      data: [
        { id: 't1', company_id: 'c1' },
        { id: 't2', company_id: 'c1' },
        { id: 't3', company_id: 'c1' },
        { id: 't4', company_id: 'c2' },
      ],
    })
    // 5. inbox items with a document that became nothing
    enqueue({ data: [{ id: 'i1', company_id: 'c1', document_id: 'd1' }] })
    // 6. document backstop: d1 still unlinked
    enqueue({ data: [{ id: 'd1', company_id: 'c1' }] })
    // 7. open deadlines: c2 has an overdue one
    enqueue({
      data: [
        {
          id: 'dl1',
          company_id: 'c2',
          title: 'Momsdeklaration',
          due_date: isoDaysFromNow(-5),
          tax_deadline_type: 'vat_declaration',
          status: 'overdue',
        },
      ],
    })
    // 8. latest posted verifikat per company (embedded)
    enqueue({
      data: [
        { id: 'c1', journal_entries: [{ entry_date: '2026-07-15' }] },
        { id: 'c2', journal_entries: [] },
      ],
    })

    const res = await GET(createMockRequest('/api/clients'), noParams)
    const { status, body } = await parseJsonResponse<{
      data: {
        team: { id: string; name: string }
        role: string
        clients: Array<{
          companyId: string
          name: string
          orgNumber: string | null
          unbookedCount: number
          inboxCount: number
          nextDeadline: { urgency: string; dueDate: string } | null
          lastBookedDate: string | null
        }>
      }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.team).toEqual({ id: 'team-1', name: 'Siffra' })
    expect(body.data.role).toBe('admin')

    // Urgency sort: c2 (overdue deadline) before c1 (bigger unbooked pile).
    expect(body.data.clients.map((c) => c.companyId)).toEqual(['c2', 'c1'])

    const [c2, c1] = body.data.clients
    expect(c2).toMatchObject({
      name: 'Beta AB',
      unbookedCount: 1,
      inboxCount: 0,
      lastBookedDate: null,
    })
    expect(c2.nextDeadline).toMatchObject({
      urgency: 'overdue',
      dueDate: isoDaysFromNow(-5),
    })

    expect(c1).toMatchObject({
      // company_settings display name wins over the frozen companies.name
      name: 'Alpha Redovisning AB',
      orgNumber: '5560125790',
      unbookedCount: 3,
      inboxCount: 1,
      nextDeadline: null,
      lastBookedDate: '2026-07-15',
    })
  })

  it('returns an empty client list for a byrå without companies', async () => {
    authed()
    enqueue({
      data: [
        {
          team_id: 'team-1',
          role: 'member',
          teams: { id: 'team-1', name: 'Siffra', kind: 'byra' },
        },
      ],
    })
    enqueue({ data: [] }) // no client companies

    const res = await GET(createMockRequest('/api/clients'), noParams)
    const { status, body } = await parseJsonResponse<{
      data: { role: string; clients: unknown[] }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.role).toBe('member')
    expect(body.data.clients).toEqual([])
  })
})
