/**
 * Tests for GET /api/bookkeeping/journal-entries/[id]/decision-receipts
 * ("Därför bokades den så": the entry's commit actor, its decision receipts
 * and the people they name).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import type { BookingWhyData } from '@/lib/suggestion-log/receipt-display'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
// Service-role client for profiles (RLS self-only), memberships and the team.
const service = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const createServiceClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: (...args: unknown[]) => createServiceClientMock(...args),
}))

import { GET } from '../route'

const JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROW = '22222222-2222-4222-8222-222222222222'

const params = (id = JE) => createMockRouteParams({ id })
const makeGet = (id = JE) =>
  createMockRequest(`/api/bookkeeping/journal-entries/${id}/decision-receipts`, { method: 'GET' })

const entryRow = {
  id: JE,
  status: 'posted',
  source_type: 'bank_transaction',
  committed_at: '2026-10-12T09:00:02.000Z',
  committed_actor_type: 'user',
  committed_actor_label: null,
  commit_method: 'user_accept',
  user_id: ANNA,
}

const decisionRow = {
  id: ROW,
  kind: 'bank_line',
  transaction_id: '11111111-1111-4111-8111-111111111111',
  inbox_item_id: null,
  document_id: null,
  suggestions: [
    {
      source: 'rule',
      source_id: 'rule:r1',
      rank: 0,
      proposal: { booking: { kind: 'account', account: '5410', vat_treatment: 'standard_25', category: 'expense_equipment' }, debit_account: '5410', credit_account: '1930', vat_treatment: 'standard_25' },
      confidence: 0.92,
      model: null,
      prompt_sha256: null,
      matches_final: true,
    },
  ],
  acted_on: 0,
  final: { journal_entry_id: JE, booking: null, account: '5410', vat_treatment: 'standard_25', lines: [] },
  outcome: 'accepted',
  actor_type: 'user',
  resolved_by: ANNA,
  created_at: '2026-10-12T09:00:00.000Z',
}

describe('GET /api/bookkeeping/journal-entries/[id]/decision-receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    service.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    createServiceClientMock.mockReturnValue(service.supabase)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(makeGet(), params())
    expect(response.status).toBe(401)
  })

  it('returns 400 for an id that is not a UUID, before any query', async () => {
    const response = await GET(makeGet('not-a-uuid'), params('not-a-uuid'))
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(findCalls('journal_entries', 'select')).toEqual([])
  })

  it("returns 404 when the entry is not the company's", async () => {
    enqueue({ data: null, error: null }) // entry lookup finds nothing

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('JOURNAL_ENTRY_NOT_FOUND')
    expect(body.error.message).toContain('hittas')
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('returns the entry, its newest decision in full and the named person with their byrå', async () => {
    enqueue({ data: entryRow, error: null }) // entry
    enqueue({ data: [decisionRow], error: null }) // suggestion_log
    enqueue({ data: [{ id: JE, voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_type: 'user', committed_actor_label: null, commit_method: 'user_accept' }], error: null }) // receipt context: entries
    enqueue({ data: [], error: null }) // pending_operations by journal_entry_id
    enqueue({ data: [], error: null }) // pending_operations by registration_journal_entry_id
    service.enqueue({ data: [{ id: ANNA, email: 'anna@example.se', full_name: 'Anna Svensson' }], error: null })
    service.enqueue({ data: [{ user_id: ANNA, source: 'team' }], error: null })
    service.enqueue({ data: { team_id: 'team-1', teams: { name: 'Siffror AB', kind: 'byra' } }, error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: BookingWhyData }>(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.data.entry).toMatchObject({ status: 'posted', committed_actor_type: 'user', user_id: ANNA })
    expect(body.data.decisions).toMatchObject({ total: 1, others: [] })
    expect(body.data.decisions?.latest).toMatchObject({ outcome: 'accepted', chosen: { source: 'rule' }, booked: { voucher: 'A12' } })
    expect(body.data.people).toEqual({ [ANNA]: { name: 'Anna Svensson', byra: true, byra_name: 'Siffror AB' } })
    // The people lookups are scoped to exactly the named ids and this company.
    expect(service.findCalls('profiles', 'in')).toEqual([['id', [ANNA]]])
    expect(service.findCalls('company_members', 'eq')).toEqual([['company_id', 'company-1']])
    expect(service.findCalls('companies', 'eq')).toEqual([['id', 'company-1']])
  })

  it('sends a samlingsverifikat as its newest decision, ten compact others and the total', async () => {
    const people = Array.from({ length: 12 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`)
    const rows = people.map((personId, i) => ({
      ...decisionRow,
      id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
      resolved_by: personId,
      created_at: `2026-10-${String(30 - i).padStart(2, '0')}T09:00:00.000Z`,
    }))
    enqueue({ data: entryRow, error: null })
    enqueue({ data: rows, error: null }) // suggestion_log, newest first
    enqueue({ data: [{ id: JE, voucher_series: 'A', voucher_number: 12, status: 'posted', committed_actor_type: 'user', committed_actor_label: null, commit_method: 'bulk_accept' }], error: null })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })
    service.enqueue({ data: [], error: null })
    service.enqueue({ data: [], error: null })
    service.enqueue({ data: null, error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: BookingWhyData }>(response)

    expect(response.status).toBe(200)
    expect(body.data.decisions?.total).toBe(12)
    expect(body.data.decisions?.latest?.receipt_id).toBe(rows[0].id)
    expect(body.data.decisions?.others).toHaveLength(10)
    // The others carry only what the list renders.
    expect(body.data.decisions?.others[0]).toEqual({
      decided_at: rows[1].created_at,
      decided_by: { actor_type: 'user', user_id: people[1], label: null },
      source: 'rule',
    })
    // Names for the latest and the listed others, not for the two left out.
    expect(service.findCalls('profiles', 'in')).toEqual([['id', people.slice(0, 11)]])
  })

  it('names no byrå for a direct member, nor for a team that is not a byrå', async () => {
    enqueue({ data: entryRow, error: null })
    enqueue({ data: [], error: null }) // no receipts
    service.enqueue({ data: [{ id: ANNA, email: 'anna@example.se', full_name: null }], error: null })
    service.enqueue({ data: [{ user_id: ANNA, source: 'team' }], error: null })
    service.enqueue({ data: { team_id: 'team-1', teams: { name: 'Annas team', kind: 'personal' } }, error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: BookingWhyData }>(response)

    expect(response.status).toBe(200)
    expect(body.data.decisions).toEqual({ latest: null, others: [], total: 0 })
    expect(body.data.people).toEqual({ [ANNA]: { name: 'anna@example.se', byra: false, byra_name: null } })
  })

  it('answers decisions null, not "none", when the receipts could not be read', async () => {
    enqueue({ data: entryRow, error: null })
    enqueue({ data: null, error: { message: 'boom', code: '57014' } }) // suggestion_log fails
    service.enqueue({ data: [{ id: ANNA, email: 'anna@example.se', full_name: 'Anna Svensson' }], error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: BookingWhyData }>(response)

    expect(response.status).toBe(200)
    expect(body.data.decisions).toBeNull()
    expect(body.data.people[ANNA]?.name).toBe('Anna Svensson')
  })

  it('still answers 200 without names when the service client cannot be created', async () => {
    enqueue({ data: entryRow, error: null })
    enqueue({ data: [], error: null })
    createServiceClientMock.mockImplementation(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY missing')
    })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: BookingWhyData }>(response)

    expect(response.status).toBe(200)
    expect(body.data.people).toEqual({})
  })

  it('skips the people lookup when no person is named', async () => {
    enqueue({ data: { ...entryRow, committed_actor_type: 'api_key', committed_actor_label: 'Zapier', commit_method: 'api_key' }, error: null })
    enqueue({ data: [], error: null })

    const response = await GET(makeGet(), params())
    expect(response.status).toBe(200)
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('returns 500 when the entry read fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await GET(makeGet(), params())
    expect(response.status).toBe(500)
  })
})
