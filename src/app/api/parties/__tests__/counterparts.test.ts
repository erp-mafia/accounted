/**
 * /api/parties/list, /api/parties/aliases and /api/parties/resolver/run: the
 * Motparter list and the person's corrections. The read model is unit-tested
 * in lib/parties/list; here the routes are checked for auth, validation and
 * what they write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const getCounterpartList = vi.fn()
vi.mock('@/lib/parties/list', () => ({
  getCounterpartList: (...args: unknown[]) => getCounterpartList(...args),
}))
const resolveCompanyCounterparts = vi.fn()
vi.mock('@/lib/parties/resolver/run', () => ({
  resolveCompanyCounterparts: (...args: unknown[]) => resolveCompanyCounterparts(...args),
  resolverMode: () => (process.env.COUNTERPARTY_RESOLVER_MODE === 'off' ? 'off' : 'act'),
}))

import { GET as listGet } from '../list/route'
import { POST as aliasesPost } from '../aliases/route'
import { POST as runPost } from '../resolver/run/route'

const noParams = { params: Promise.resolve({}) }

describe('GET /api/parties/list', () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  })

  it('returns 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null })
    const res = await listGet(createMockRequest('http://localhost/api/parties/list'), noParams)
    expect(res.status).toBe(401)
  })

  it('rejects an unknown period', async () => {
    const res = await listGet(createMockRequest('http://localhost/api/parties/list?period=3y'), noParams)
    expect(res.status).toBe(400)
  })

  it('hands the page the list for the active company', async () => {
    getCounterpartList.mockResolvedValueOnce({ rows: [], counts: { total: 0 }, period: '12m', scbConfigured: false })
    const { status, body } = await parseJsonResponse<{ data: { period: string } }>(await listGet(createMockRequest('http://localhost/api/parties/list?q=anthropic&period=all'), noParams))
    expect(status).toBe(200)
    expect(getCounterpartList).toHaveBeenCalledWith(expect.anything(), 'company-1', { q: 'anthropic', period: 'all' })
    expect(body.data.period).toBe('12m')
  })
})

describe('POST /api/parties/aliases', () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  })

  it('validates the body', async () => {
    const res = await aliasesPost(createMockRequest('http://localhost/api/parties/aliases', { method: 'POST', body: { aliasKeys: [], action: 'rename', name: 'X' } }), noParams)
    expect(res.status).toBe(400)
    const noName = await aliasesPost(createMockRequest('http://localhost/api/parties/aliases', { method: 'POST', body: { aliasKeys: ['k'], action: 'rename' } }), noParams)
    expect(noName.status).toBe(400)
  })

  it('is 404 when no live alias carries the keys', async () => {
    enqueue({ data: [] })
    const res = await aliasesPost(createMockRequest('http://localhost/api/parties/aliases', { method: 'POST', body: { aliasKeys: ['nope'], action: 'not_same' } }), noParams)
    expect(res.status).toBe(404)
  })

  it('supersedes the live rows with the outcome and writes the person\'s answer', async () => {
    enqueue({ data: [{ id: 'a1', alias_key: 'hotel hansson', sample_text: 'HOTEL HANSSON', display_name: 'Hotel at Booking.com', kind: 'merchant', rail: null, country: 'SE', what: null }] })
    enqueue({ data: { id: 'party-hansson' } }) // party with the new name
    enqueue({ data: null }) // update
    enqueue({ data: null }) // insert
    const { status, body } = await parseJsonResponse<{ data: { updated: number; partyId: string | null } }>(
      await aliasesPost(createMockRequest('http://localhost/api/parties/aliases', { method: 'POST', body: { aliasKeys: ['hotel hansson'], action: 'rename', name: 'Hotel Hansson' } }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ updated: 1, partyId: 'party-hansson' })
    expect(findCall('counterparty_aliases', 'update')?.[0]).toMatchObject({ human_outcome: 'disagree' })
    const inserted = findCalls('counterparty_aliases', 'insert')[0]?.[0] as Array<Record<string, unknown>>
    expect(inserted[0]).toMatchObject({ alias_key: 'hotel hansson', display_name: 'Hotel Hansson', party_id: 'party-hansson', source: 'person', band: 'link', confidence: 1, user_id: 'user-1' })
  })

  it('records "not the same" as a nil row', async () => {
    enqueue({ data: [{ id: 'a1', alias_key: 'x', sample_text: 'X', display_name: 'Wrong', kind: 'merchant', rail: null, country: null, what: 'stuff' }] })
    enqueue({ data: null })
    enqueue({ data: null })
    const res = await aliasesPost(createMockRequest('http://localhost/api/parties/aliases', { method: 'POST', body: { aliasKeys: ['x'], action: 'not_same' } }), noParams)
    expect(res.status).toBe(200)
    const inserted = findCalls('counterparty_aliases', 'insert')[0]?.[0] as Array<Record<string, unknown>>
    expect(inserted[0]).toMatchObject({ display_name: null, band: 'nil', kind: 'unsure', what: null, source: 'person' })
  })
})

describe('POST /api/parties/resolver/run', () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
    delete process.env.COUNTERPARTY_RESOLVER_MODE
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  })

  it('runs the resolver for the active company and returns the counts', async () => {
    resolveCompanyCounterparts.mockResolvedValueOnce({ strings: 5, planned: 2, written: 2, modelLines: 1, byBand: { link: 2, tentative: 0, nil: 0 } })
    const { status, body } = await parseJsonResponse<{ data: { written: number; skipped: boolean } }>(await runPost(createMockRequest('http://localhost/api/parties/resolver/run', { method: 'POST' }), noParams))
    expect(status).toBe(200)
    expect(resolveCompanyCounterparts).toHaveBeenCalledWith(expect.anything(), 'company-1', { maxModelLines: 200 })
    expect(body.data).toMatchObject({ written: 2, skipped: false })
  })

  it('skips when the resolver is off', async () => {
    process.env.COUNTERPARTY_RESOLVER_MODE = 'off'
    const { body } = await parseJsonResponse<{ data: { skipped: boolean } }>(await runPost(createMockRequest('http://localhost/api/parties/resolver/run', { method: 'POST' }), noParams))
    expect(body.data.skipped).toBe(true)
    expect(resolveCompanyCounterparts).not.toHaveBeenCalled()
  })

  it('does not leak the failure text', async () => {
    resolveCompanyCounterparts.mockRejectedValueOnce(new Error('relation counterparty_aliases does not exist'))
    const { status, body } = await parseJsonResponse<unknown>(await runPost(createMockRequest('http://localhost/api/parties/resolver/run', { method: 'POST' }), noParams))
    expect(status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('does not exist')
  })
})
