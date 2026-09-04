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
const searchByName = vi.fn()
vi.mock('@/lib/parties/scb/client', () => ({ createScbClient: () => ({ lookupByOrgNumber, searchByName }) }))
const configured = { value: true }
vi.mock('@/lib/parties/scb/config', () => ({
  isScbConfigured: () => configured.value,
  scbConfigFromEnv: () => ({ baseUrl: 'https://scb.test', pfx: Buffer.from('x'), passphrase: 'p', timeoutMs: 1 }),
}))

import { POST } from '../route'
import { GET as candidatesGet } from '../candidates/route'

const user = { id: 'user-1', email: 'test@test.se' }
const PARTY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const call = (id = PARTY) => POST(createMockRequest(`/api/parties/${id}/enrich`, { method: 'POST' }), { params: Promise.resolve({ id }) })
const callWith = (body: unknown, id = PARTY) => {
  const req = createMockRequest(`/api/parties/${id}/enrich`, { method: 'POST', body })
  return POST(req, { params: Promise.resolve({ id }) })
}
const candidates = (q?: string, id = PARTY) => candidatesGet(createMockRequest(`/api/parties/${id}/enrich/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`), { params: Promise.resolve({ id }) })

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

describe('GET /api/parties/[id]/enrich/candidates', () => {
  it('returns 503 when SCB is not configured and 404 for a foreign party', async () => {
    configured.value = false
    expect((await parseJsonResponse(await candidates())).status).toBe(503)
    configured.value = true
    enqueue({ data: null })
    expect((await parseJsonResponse(await candidates())).status).toBe(404)
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('searches on the party name by default and on q when given', async () => {
    const result = { query: 'Adobe Systems Software', mode: 'starts_with', total: 2, truncated: false, candidates: [] }
    enqueue({ data: { id: PARTY, display_name: 'Adobe Systems Software', legal_name: null } })
    searchByName.mockResolvedValue(result)
    const a = await parseJsonResponse<{ data: typeof result }>(await candidates())
    expect(a.status).toBe(200)
    expect(a.body.data).toEqual(result)
    expect(searchByName).toHaveBeenLastCalledWith('Adobe Systems Software')
    enqueue({ data: { id: PARTY, display_name: 'Adobe Systems Software', legal_name: null } })
    await candidates('Adobe Nordic')
    expect(searchByName).toHaveBeenLastCalledWith('Adobe Nordic')
  })

  it('maps an SCB failure to 502', async () => {
    enqueue({ data: { id: PARTY, display_name: 'Adobe', legal_name: null } })
    searchByName.mockRejectedValue(new Error('boom'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await candidates())
    expect(status).toBe(502)
    expect(body.error.code).toBe('SCB_LOOKUP_FAILED')
  })
})

describe('POST /api/parties/[id]/enrich with a picked org number', () => {
  it('rejects a malformed number, a sole trader, and a party that already has one', async () => {
    expect((await parseJsonResponse(await callWith({ orgNumber: '12' }))).status).toBe(400)
    enqueue({ data: { id: PARTY, org_number: null, legal_name: null, vat_number: null } })
    expect((await parseJsonResponse(await callWith({ orgNumber: '8001011234' }))).status).toBe(400)
    enqueue({ data: { id: PARTY, org_number: '5564300142', legal_name: null, vat_number: null } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await callWith({ orgNumber: '5564082161' }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('CONFLICT')
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('refuses a number another live party already holds, naming it', async () => {
    enqueue({ data: { id: PARTY, org_number: null, legal_name: null, vat_number: null } })
    enqueue({ data: { id: OTHER, display_name: 'Adobe Systems Nordic AB' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { reason: string; displayName: string } } }>(await callWith({ orgNumber: '5564082161' }))
    expect(status).toBe(409)
    expect(body.error.details).toMatchObject({ reason: 'org_number_taken', displayName: 'Adobe Systems Nordic AB' })
    expect(lookupByOrgNumber).not.toHaveBeenCalled()
  })

  it('sets the number as a user fact, then fetches by number', async () => {
    enqueue({ data: { id: PARTY, org_number: null, legal_name: null, vat_number: null } })
    enqueue({ data: null }) // no holder
    enqueue({ data: null }) // parties.update org_number
    enqueue({ data: { inserted: 1, superseded: 0, refreshed: 0 } }) // record_party_facts (user)
    lookupByOrgNumber.mockResolvedValue({ found: true, peOrgNr: '165564082161', row: {}, facts: [{ field: 'legal_name', value: 'Adobe Systems Nordic Aktiebolag' }], fetchedAt: '2026-09-03T10:00:00Z' })
    enqueue({ data: { inserted: 1, superseded: 0, refreshed: 0 } }) // record_party_facts (registry)
    enqueue({ data: null, count: 0 }) // no user legal name
    enqueue({ data: null }) // parties.update legal_name
    const { status, body } = await parseJsonResponse<{ data: { found: boolean; orgNumber: string } }>(await callWith({ orgNumber: '556408-2161' }))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ found: true, orgNumber: '5564082161' })
    expect(mockSupabase.rpc).toHaveBeenNthCalledWith(1, 'record_party_facts', expect.objectContaining({ p_source: 'user', p_facts: [{ field: 'org_number', value: '5564082161', reference: { picked_from: 'scb_search' } }] }))
    expect(lookupByOrgNumber).toHaveBeenCalledWith('5564082161')
  })
})
