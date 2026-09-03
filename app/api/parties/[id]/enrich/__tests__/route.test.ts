import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
const lookupByOrgNumber = vi.fn()
vi.mock('@/lib/parties/scb/client', () => ({ createScbClient: () => ({ lookupByOrgNumber }) }))
const configured = { value: true }
vi.mock('@/lib/parties/scb/config', () => ({
  isScbConfigured: () => configured.value,
  scbConfigFromEnv: () => ({ baseUrl: 'https://scb.test', pfx: Buffer.from('x'), passphrase: 'p', timeoutMs: 1 }),
}))

import { POST } from '../route'

const user = { id: 'user-1', email: 'test@test.se' }
const PARTY = '11111111-1111-4111-8111-111111111111'
const call = (id = PARTY) => POST(createMockRequest(`/api/parties/${id}/enrich`, { method: 'POST' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  configured.value = true
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user } })
})

describe('POST /api/parties/[id]/enrich', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await parseJsonResponse(await call())).status).toBe(401)
  })

  it('returns 503 when SCB is not configured, before touching the database', async () => {
    configured.value = false
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(503)
    expect(body.error.code).toBe('SCB_NOT_CONFIGURED')
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a party outside the company', async () => {
    enqueue({ data: null })
    expect((await parseJsonResponse(await call())).status).toBe(404)
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('refuses a sole trader with 400 and never calls SCB', async () => {
    enqueue({ data: { id: PARTY, org_number: '8001011234', legal_name: null } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(400)
    expect(body.error.code).toBe('SCB_NOT_A_LEGAL_PERSON')
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('maps an SCB failure to 502', async () => {
    enqueue({ data: { id: PARTY, org_number: '5560125790', legal_name: null } })
    lookupByOrgNumber.mockRejectedValue(new Error('boom'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await call())
    expect(status).toBe(502)
    expect(body.error.code).toBe('SCB_LOOKUP_FAILED')
  })

  it('reports not found without writing anything', async () => {
    enqueue({ data: { id: PARTY, org_number: '5560125790', legal_name: null } })
    lookupByOrgNumber.mockResolvedValue({ found: false, peOrgNr: '165560125790', row: null, facts: [], fetchedAt: '2026-09-03T10:00:00Z' })
    const { status, body } = await parseJsonResponse<{ data: { found: boolean; orgNumber: string } }>(await call())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ found: false, orgNumber: '5560125790' })
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('records the facts with provenance and fills an empty legal name', async () => {
    enqueue({ data: { id: PARTY, org_number: '5560125790', legal_name: null } })
    lookupByOrgNumber.mockResolvedValue({
      found: true,
      peOrgNr: '165560125790',
      row: {},
      facts: [
        { field: 'legal_name', value: 'Beijer Byggmaterial AB' },
        { field: 'f_tax', value: { code: '1', label: 'Godkänd för F-skatt' } },
      ],
      fetchedAt: '2026-09-03T10:00:00Z',
    })
    enqueue({ data: { inserted: 2, superseded: 0, refreshed: 0 } })
    enqueue({ data: null, count: 0 }) // no user-entered legal name
    enqueue({ data: null }) // parties.update
    const { status, body } = await parseJsonResponse<{ data: { found: boolean; inserted: number; facts: unknown[] } }>(await call())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ found: true, inserted: 2 })
    expect(body.data.facts).toHaveLength(2)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('record_party_facts', {
      p_company_id: 'company-1',
      p_user_id: 'user-1',
      p_party_id: PARTY,
      p_source: 'registry_scb',
      p_facts: [
        { field: 'legal_name', value: 'Beijer Byggmaterial AB', reference: { layout: 'Je', pe_org_nr: '165560125790' } },
        { field: 'f_tax', value: { code: '1', label: 'Godkänd för F-skatt' }, reference: { layout: 'Je', pe_org_nr: '165560125790' } },
      ],
      p_fetched_at: '2026-09-03T10:00:00Z',
    })
    expect(lookupByOrgNumber).toHaveBeenCalledWith('5560125790')
  })
})

describe('POST /api/parties/[id]/enrich, legal name survivorship', () => {
  it('replaces a document-sourced legal name with the registry name, but never one a person entered', async () => {
    enqueue({ data: { id: PARTY, org_number: '5560125790', legal_name: 'Beijer Bygg' } })
    lookupByOrgNumber.mockResolvedValue({ found: true, peOrgNr: '165560125790', row: {}, facts: [{ field: 'legal_name', value: 'AKTIEBOLAGET VOLVO' }], fetchedAt: '2026-09-03T10:00:00Z' })
    enqueue({ data: { inserted: 1, superseded: 0, refreshed: 0 } })
    enqueue({ data: null, count: 1 }) // a user-entered legal name exists
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    const updates = mockSupabase.from.mock.calls.filter((c) => c[0] === 'parties').length
    // one lookup, no update
    expect(updates).toBe(1)
  })
})
