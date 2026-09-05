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
vi.mock('@/lib/parties/scb/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/parties/scb/client')>()),
  createScbClient: () => ({ lookupByOrgNumber, searchByName }),
}))
const readCounterpartName = vi.fn()
const ai = { available: false, capability: true }
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: () => Promise.resolve(ai.capability) }))
vi.mock('@/lib/parties/ai-name', () => ({
  readCounterpartName: (texts: string[]) => readCounterpartName(texts),
  aiNameAvailable: () => ai.available,
}))
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
  ai.available = false
  ai.capability = true
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
    enqueue({ data: [] })
    searchByName.mockResolvedValue(result)
    const a = await parseJsonResponse<{ data: typeof result }>(await candidates())
    expect(a.status).toBe(200)
    expect(a.body.data).toEqual({ ...result, queries: ['Adobe Systems Software'], foreign: null, aiRead: null })
    expect(searchByName).toHaveBeenLastCalledWith('Adobe Systems Software')
    enqueue({ data: { id: PARTY, display_name: 'Adobe Systems Software', legal_name: null } })
    await candidates('Adobe Nordic')
    expect(searchByName).toHaveBeenLastCalledWith('Adobe Nordic')
  })

  it('reads the legal person out of the voucher text and stops at the first query with a hit', async () => {
    const miss = { query: 'The Intelligence Company', mode: 'contains', total: 0, truncated: false, candidates: [] }
    const hit = { query: 'TIC identity', mode: 'starts_with', total: 1, truncated: false, candidates: [{ orgNumber: '5567890123', name: 'TIC Identity AB', active: true }] }
    enqueue({ data: { id: PARTY, display_name: 'TIC identity', legal_name: null } })
    enqueue({
      data: [{ field: 'voucher_text', value: ['TIC identity     BG 0000005786439 Bg-bet. via internet · Faktura 20250746, The Intelligence Company AB (publ). TIC Identity-abonnemang.'] }],
    })
    searchByName.mockResolvedValueOnce(miss).mockResolvedValueOnce(hit)
    const { status, body } = await parseJsonResponse<{ data: { query: string; queries: string[]; candidates: unknown[] } }>(await candidates())
    expect(status).toBe(200)
    expect(searchByName.mock.calls.map((c) => c[0])).toEqual(['The Intelligence Company', 'TIC identity'])
    expect(body.data.queries).toEqual(['The Intelligence Company', 'TIC identity'])
    expect(body.data.candidates).toHaveLength(1)
  })

  it('lets the model read a bank memo once, keeps the reading as a fact, and searches on it', async () => {
    ai.available = true
    readCounterpartName.mockResolvedValue({ name: 'Booking.com', country: 'NL', vatNumber: null, confidence: 'high', model: 'm' })
    enqueue({ data: { id: PARTY, display_name: 'Hotel at Booking.com', legal_name: null } })
    enqueue({ data: [{ field: 'voucher_text', value: ['Hotel at Booking.com K3667 Kortköp/uttag · Hotell, svenskt boende, 12% moms'] }] })
    enqueue({ data: { recorded: 1 } }) // record_party_facts
    const { status, body } = await parseJsonResponse<{ data: { queries: string[]; foreign: unknown; aiRead: unknown; candidates: unknown[] } }>(await candidates())
    expect(status).toBe(200)
    expect(readCounterpartName).toHaveBeenCalledWith(['Hotel at Booking.com', 'Hotel at Booking.com K3667 Kortköp/uttag · Hotell, svenskt boende, 12% moms'])
    // A Dutch reading: no SCB call, the picker explains, the reading is shown.
    expect(searchByName).not.toHaveBeenCalled()
    expect(body.data.foreign).toEqual({ name: 'Booking.com', country: 'NL' })
    expect(body.data.aiRead).toEqual({ name: 'Booking.com', country: 'NL' })
    const rpc = mockSupabase.rpc.mock.calls.find((c) => c[0] === 'record_party_facts')
    expect(rpc?.[1]).toMatchObject({ p_source: 'model', p_party_id: PARTY, p_facts: [{ field: 'ai_name' }] })

    // Cached: no second model call, and a Swedish reading is searched for.
    readCounterpartName.mockClear()
    enqueue({ data: { id: PARTY, display_name: 'UBER *TRIP HELP.UBER.COM', legal_name: null } })
    enqueue({ data: [{ field: 'ai_name', value: { name: 'Uber Sweden AB', country: 'SE', vatNumber: null, confidence: 'high', model: 'm' } }] })
    searchByName.mockResolvedValue({ query: 'Uber Sweden', mode: 'starts_with', total: 1, truncated: false, candidates: [{ orgNumber: '5567890123', name: 'Uber Sweden AB', active: true }] })
    const second = await parseJsonResponse<{ data: { queries: string[]; aiRead: unknown } }>(await candidates())
    expect(readCounterpartName).not.toHaveBeenCalled()
    expect(searchByName).toHaveBeenLastCalledWith('Uber Sweden')
    expect(second.body.data.aiRead).toEqual({ name: 'Uber Sweden AB', country: 'SE' })
  })

  it('does not call the model when the rules already anchored a name, when the company lacks the AI capability, or when no model is configured', async () => {
    ai.available = true
    enqueue({ data: { id: PARTY, display_name: 'Visma Spcs AB', legal_name: null } })
    enqueue({ data: [] })
    searchByName.mockResolvedValue({ query: 'Visma Spcs', mode: 'starts_with', total: 1, truncated: false, candidates: [] })
    await candidates()
    expect(readCounterpartName).not.toHaveBeenCalled()
    ai.capability = false
    enqueue({ data: { id: PARTY, display_name: 'Hotel at Booking.com', legal_name: null } })
    enqueue({ data: [] })
    await candidates()
    expect(readCounterpartName).not.toHaveBeenCalled()
    ai.capability = true
    ai.available = false
    enqueue({ data: { id: PARTY, display_name: 'Hotel at Booking.com', legal_name: null } })
    enqueue({ data: [] })
    await candidates()
    expect(readCounterpartName).not.toHaveBeenCalled()
  })

  it('never asks SCB about a foreign company, and says which one it read', async () => {
    enqueue({ data: { id: PARTY, display_name: 'Framer B.V.', legal_name: null } })
    enqueue({ data: [{ field: 'voucher_text', value: ['Utlägg Framer · Framer B.V. (NL), webbdesignverktyg.'] }] })
    const { status, body } = await parseJsonResponse<{ data: { queries: string[]; candidates: unknown[]; foreign: unknown } }>(await candidates())
    expect(status).toBe(200)
    expect(searchByName).not.toHaveBeenCalled()
    expect(body.data.queries).toEqual([])
    expect(body.data.candidates).toEqual([])
    expect(body.data.foreign).toEqual({ name: 'Framer B.V.', legalForm: 'B.V.', country: 'NL' })
  })

  it('maps an SCB failure to 502', async () => {
    enqueue({ data: { id: PARTY, display_name: 'Adobe', legal_name: null } })
    enqueue({ data: [] })
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
