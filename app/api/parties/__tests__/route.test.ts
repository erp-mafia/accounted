/**
 * /api/parties: the Kontakter register and its write actions. The read model
 * and the pipeline are unit-tested in lib/parties; here the routes are
 * checked for auth, validation and the shape they hand the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const getRegister = vi.fn()
const getDossier = vi.fn()
vi.mock('@/lib/parties/register', () => ({
  getRegister: (...args: unknown[]) => getRegister(...args),
  getDossier: (...args: unknown[]) => getDossier(...args),
}))
const suggestPartiesForCompany = vi.fn()
vi.mock('@/lib/parties/suggest', () => ({
  suggestPartiesForCompany: (...args: unknown[]) => suggestPartiesForCompany(...args),
}))

import { GET as listGet } from '../route'
import { GET as dossierGet } from '../[id]/route'
import { POST as suggestPost } from '../suggest/route'
import { POST as decidePost } from '../decide/route'
import { POST as undoDecidePost } from '../decide/undo/route'
import { POST as mergePost } from '../merge/route'
import { POST as undoMergePost } from '../merge/undo/route'

const user = { id: 'user-1', email: 'test@test.se' }
const noParams = { params: Promise.resolve({}) }
const PARTY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const DECISION = '33333333-3333-4333-8333-333333333333'

function json(url: string, body: unknown) {
  return createMockRequest(url, { method: 'POST', body })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user } })
})

describe('GET /api/parties', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await listGet(createMockRequest('/api/parties'), noParams))
    expect(status).toBe(401)
  })

  it('rejects an unknown view with 400', async () => {
    const { status } = await parseJsonResponse(await listGet(createMockRequest('/api/parties?view=nope'), noParams))
    expect(status).toBe(400)
    expect(getRegister).not.toHaveBeenCalled()
  })

  it('passes view, query and period to the read model for the active company', async () => {
    const register = { counts: { all: 1, customers: 0, suppliers: 1, suggested: 0, observed: 0 }, rows: [], observed: [], generic: { count: 0, expenseSek: 0, examples: [] }, period: 'all' }
    getRegister.mockResolvedValue(register)
    const { status, body } = await parseJsonResponse<{ data: typeof register }>(
      await listGet(createMockRequest('/api/parties?view=suppliers&q=beijer&period=all'), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual(register)
    expect(getRegister).toHaveBeenCalledWith(mockSupabase, 'company-1', { view: 'suppliers', q: 'beijer', period: 'all' })
  })
})

describe('GET /api/parties/[id]', () => {
  it('returns 404 for a party that is not in the company', async () => {
    getDossier.mockResolvedValue(null)
    const { status } = await parseJsonResponse(
      await dossierGet(createMockRequest(`/api/parties/${PARTY}`), { params: Promise.resolve({ id: PARTY }) }),
    )
    expect(status).toBe(404)
  })

  it('returns 404 for a malformed id without touching the database', async () => {
    const { status } = await parseJsonResponse(
      await dossierGet(createMockRequest('/api/parties/not-a-uuid'), { params: Promise.resolve({ id: 'not-a-uuid' }) }),
    )
    expect(status).toBe(404)
    expect(getDossier).not.toHaveBeenCalled()
  })

  it('returns the dossier', async () => {
    const dossier = { party: { id: PARTY, displayName: 'Loopia AB' }, facts: [], identities: [], decisions: [], vouchers: [], similar: [] }
    getDossier.mockResolvedValue(dossier)
    const { status, body } = await parseJsonResponse<{ data: typeof dossier }>(
      await dossierGet(createMockRequest(`/api/parties/${PARTY}`), { params: Promise.resolve({ id: PARTY }) }),
    )
    expect(status).toBe(200)
    expect(body.data.party.displayName).toBe('Loopia AB')
    expect(getDossier).toHaveBeenCalledWith(mockSupabase, 'company-1', PARTY)
  })
})

describe('POST /api/parties/suggest', () => {
  it('runs the pipeline for the caller and company', async () => {
    const summary = { observed: 10, suggested: 4, skipped: 6, created: 3, attached: 1, identities: 2, facts: 5 }
    suggestPartiesForCompany.mockResolvedValue(summary)
    const { status, body } = await parseJsonResponse<{ data: typeof summary }>(await suggestPost(createMockRequest('/api/parties/suggest', { method: 'POST' }), noParams))
    expect(status).toBe(200)
    expect(body.data).toEqual(summary)
    expect(suggestPartiesForCompany).toHaveBeenCalledWith(mockSupabase, 'company-1', 'user-1')
  })
})

describe('POST /api/parties/decide', () => {
  it('rejects an empty id list and an unknown kind', async () => {
    const a = await parseJsonResponse(await decidePost(json('/api/parties/decide', { partyIds: [], kind: 'confirm' }), noParams))
    expect(a.status).toBe(400)
    const b = await parseJsonResponse(await decidePost(json('/api/parties/decide', { partyIds: [PARTY], kind: 'merge' }), noParams))
    expect(b.status).toBe(400)
  })

  it('calls decide_parties with the caller identity and returns the count', async () => {
    enqueue({ data: 2 })
    const { status, body } = await parseJsonResponse<{ data: { count: number; kind: string } }>(
      await decidePost(json('/api/parties/decide', { partyIds: [PARTY, OTHER], kind: 'confirm', note: 'from queue' }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ count: 2, kind: 'confirm' })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('decide_parties', {
      p_company_id: 'company-1',
      p_user_id: 'user-1',
      p_party_ids: [PARTY, OTHER],
      p_kind: 'confirm',
      p_note: 'from queue',
    })
  })
})

describe('POST /api/parties/decide/undo', () => {
  it('reverses the latest decisions for the given parties', async () => {
    enqueue({ data: 1 })
    const { status, body } = await parseJsonResponse<{ data: { count: number } }>(
      await undoDecidePost(json('/api/parties/decide/undo', { partyIds: [PARTY] }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ count: 1 })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('undo_party_decisions', { p_company_id: 'company-1', p_user_id: 'user-1', p_party_ids: [PARTY] })
  })
})

describe('POST /api/parties/merge', () => {
  it('rejects a survivor listed among the merged ids', async () => {
    const { status } = await parseJsonResponse(await mergePost(json('/api/parties/merge', { survivorId: PARTY, mergedIds: [PARTY] }), noParams))
    expect(status).toBe(400)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('maps a foreign or merged party to 404', async () => {
    enqueue({ data: null, error: { code: '23503', message: 'survivor is not a live party of this company' } })
    const { status } = await parseJsonResponse(await mergePost(json('/api/parties/merge', { survivorId: PARTY, mergedIds: [OTHER] }), noParams))
    expect(status).toBe(404)
  })

  it('returns the decision id for undo', async () => {
    enqueue({ data: DECISION })
    const { status, body } = await parseJsonResponse<{ data: { decisionId: string; survivorId: string; mergedIds: string[] } }>(
      await mergePost(json('/api/parties/merge', { survivorId: PARTY, mergedIds: [OTHER], note: 'same supplier' }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ decisionId: DECISION, survivorId: PARTY, mergedIds: [OTHER] })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('merge_parties', {
      p_company_id: 'company-1',
      p_user_id: 'user-1',
      p_survivor: PARTY,
      p_merged: [OTHER],
      p_note: 'same supplier',
    })
  })
})

describe('POST /api/parties/merge/undo', () => {
  it('validates the decision id', async () => {
    const { status } = await parseJsonResponse(await undoMergePost(json('/api/parties/merge/undo', { decisionId: 'x' }), noParams))
    expect(status).toBe(400)
  })

  it('restores the merged parties', async () => {
    enqueue({ data: 2 })
    const { status, body } = await parseJsonResponse<{ data: { restored: number } }>(
      await undoMergePost(json('/api/parties/merge/undo', { decisionId: DECISION }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ restored: 2 })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('undo_party_merge', { p_company_id: 'company-1', p_user_id: 'user-1', p_decision_id: DECISION })
  })
})
