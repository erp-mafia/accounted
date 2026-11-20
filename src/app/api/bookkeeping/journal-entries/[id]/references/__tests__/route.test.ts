import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueueMany, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

/**
 * The resolver's fixed `.from()` order (see
 * lib/core/bookkeeping/__tests__/journal-entry-references.test.ts): invoices,
 * invoice_payments, supplier_invoices x2, supplier_invoice_payments, then the
 * entry's own source columns and the salary run they name.
 */
const NO_INVOICE_LINKS = [
  { data: [] }, // invoices direct
  { data: [] }, // invoice_payments
  { data: [] }, // supplier_invoices (registration)
  { data: [] }, // supplier_invoices (payment)
  { data: [] }, // supplier_invoice_payments
]

type Body = { data: { references: { type: string; id: string; number: string }[] } }

describe('GET /api/bookkeeping/journal-entries/[id]/references', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-1/references'),
      createMockRouteParams({ id: 'je-1' }),
    )

    expect(response.status).toBe(401)
  })

  it('returns the lönekörning that posted the entry as a followable reference', async () => {
    enqueueMany([
      ...NO_INVOICE_LINKS,
      { data: { source_type: 'salary_payment', source_id: 'run-1' } }, // journal_entries
      { data: { id: 'run-1', period_year: 2026, period_month: 7 } }, // salary_runs
    ])

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-1/references'),
      createMockRouteParams({ id: 'je-1' }),
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data.references).toEqual([
      { type: 'salary_run', id: 'run-1', number: '2026-07' },
    ])
  })

  it('returns a customer invoice reference unchanged', async () => {
    enqueueMany([
      { data: [{ id: 'inv-1', invoice_number: '003' }] }, // invoices direct
      { data: [] }, // invoice_payments
      { data: [] }, // supplier_invoices (registration)
      { data: [] }, // supplier_invoices (payment)
      { data: [] }, // supplier_invoice_payments
      { data: { source_type: 'manual', source_id: null } }, // journal_entries
    ])

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-1/references'),
      createMockRouteParams({ id: 'je-1' }),
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data.references).toEqual([{ type: 'invoice', id: 'inv-1', number: '003' }])
  })

  it('resolves an id outside the active company to no references, never a leak', async () => {
    // Every underlying query is company-scoped, so a foreign id simply finds
    // nothing: the route neither 404s nor discloses that the entry exists.
    enqueueMany([...NO_INVOICE_LINKS, { data: null }]) // journal_entries: not ours

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-other/references'),
      createMockRouteParams({ id: 'je-other' }),
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data.references).toEqual([])
  })

  it('names the object the verifikat books as owned_by', async () => {
    enqueueMany([
      ...NO_INVOICE_LINKS,
      { data: { source_type: 'accrual', source_id: 'sched-1' } }, // journal_entries (references)
      { data: { id: 'je-1', source_type: 'accrual', source_id: 'sched-1', correction_of_id: null, reverses_id: null } }, // journal_entries (owner)
      { data: { id: 'sched-1', description: 'Hyra' } }, // accrual_schedules
    ])

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-1/references'),
      createMockRouteParams({ id: 'je-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { owned_by: Record<string, unknown> | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.owned_by).toMatchObject({ kind: 'accrual_schedule', owner_id: 'sched-1', action: 'open_accrual' })
  })

  it('answers owned_by null for a verifikat no object owns', async () => {
    enqueueMany([
      ...NO_INVOICE_LINKS,
      { data: { source_type: 'manual', source_id: null } },
      { data: { id: 'je-1', source_type: 'manual', source_id: null, correction_of_id: null, reverses_id: null } },
    ])

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-1/references'),
      createMockRouteParams({ id: 'je-1' }),
    )
    const { body } = await parseJsonResponse<{ data: { owned_by: unknown } }>(response)

    expect(body.data.owned_by).toBeNull()
  })

  it('marks the payload private, no-store: it carries financial identifiers', async () => {
    enqueueMany([...NO_INVOICE_LINKS, { data: null }])

    const response = await GET(
      createMockRequest('/api/bookkeeping/journal-entries/je-1/references'),
      createMockRouteParams({ id: 'je-1' }),
    )

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
