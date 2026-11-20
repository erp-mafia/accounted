import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/loss-carryforward/register', () => ({
  listLossCarryforwards: vi.fn(),
  saveLossCarryforward: vi.fn(),
  getLossCarryforward: vi.fn(),
}))
vi.mock('@/lib/bokslut/loss-carryforward/proposal', () => ({ proposeLossCarryforward: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import {
  getLossCarryforward,
  listLossCarryforwards,
  saveLossCarryforward,
} from '@/lib/bokslut/loss-carryforward/register'
import { proposeLossCarryforward } from '@/lib/bokslut/loss-carryforward/proposal'
import { GET, POST } from '../route'
import { GET as GET_ONE } from '../[id]/route'
import { GET as GET_PROPOSAL } from '../proposal/route'

const supabase = {}
const PERIOD = '00000000-0000-4000-8000-000000000026'
const year = { tax_loss_carryforward_id: 'tlc-1', fiscal_period_id: PERIOD, brought_forward: 100_000, carried_forward: 40_000, warnings: [] }
const body = { fiscal_period_id: PERIOD, brought_forward: 100_000, source: 'tax_assessment', result_before_deficit: 60_000 }
const noParams = { params: Promise.resolve({}) } as never

function unauthenticated() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

describe('GET /api/bookkeeping/tax-loss-carryforwards', () => {
  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await GET(createMockRequest('/api/bookkeeping/tax-loss-carryforwards'), noParams)).status).toBe(401)
    expect(listLossCarryforwards).not.toHaveBeenCalled()
  })

  it('answers 403 LOSS_CARRYFORWARD_UNAVAILABLE while the switch leaves the company out', async () => {
    vi.mocked(listLossCarryforwards).mockResolvedValue({ ok: false, code: 'LOSS_CARRYFORWARD_UNAVAILABLE' })
    const res = await GET(createMockRequest('/api/bookkeeping/tax-loss-carryforwards'), noParams)
    expect(res.status).toBe(403)
    const { body: json } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(json.error.code).toBe('LOSS_CARRYFORWARD_UNAVAILABLE')
  })

  it('lists the register for the active company', async () => {
    vi.mocked(listLossCarryforwards).mockResolvedValue({ ok: true, data: { tax_loss_carryforwards: [year as never] } })
    const res = await GET(createMockRequest('/api/bookkeeping/tax-loss-carryforwards'), noParams)
    expect(res.status).toBe(200)
    const { body: json } = await parseJsonResponse<{ data: { tax_loss_carryforwards: unknown[] } }>(res)
    expect(json.data.tax_loss_carryforwards).toEqual([year])
    expect(listLossCarryforwards).toHaveBeenCalledWith(expect.objectContaining({ supabase, companyId: 'company-1' }))
  })
})

describe('POST /api/bookkeeping/tax-loss-carryforwards', () => {
  const post = (payload: unknown, query = '') =>
    POST(createMockRequest(`/api/bookkeeping/tax-loss-carryforwards${query}`, { method: 'POST', body: payload }), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await post(body)).status).toBe(401)
    expect(saveLossCarryforward).not.toHaveBeenCalled()
  })

  it('returns 400 for a negative deficit, an unknown source, an unknown field or an empty ownership change', async () => {
    expect((await post({ ...body, brought_forward: -1 })).status).toBe(400)
    expect((await post({ ...body, source: 'guess' })).status).toBe(400)
    expect((await post({ ...body, extra: true })).status).toBe(400)
    expect((await post({ ...body, ownership_change: { date: '2026-06-01', amount_block: false, group_block: false } })).status).toBe(400)
    expect(saveLossCarryforward).not.toHaveBeenCalled()
  })

  it('answers 404 for a fiscal period the company does not have', async () => {
    vi.mocked(saveLossCarryforward).mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
    expect((await post(body)).status).toBe(404)
  })

  it('answers 422 with the Swedish reason when the spärrar exceed 4.14 a', async () => {
    vi.mocked(saveLossCarryforward).mockResolvedValue({ ok: false, code: 'LOSS_CARRYFORWARD_REDUCTIONS_EXCEED' })
    const res = await post(body)
    expect(res.status).toBe(422)
    const { body: json } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(json.error.message).toContain('4.14 a')
  })

  it('saves the year in the caller\'s name and answers 201 for a new one', async () => {
    vi.mocked(saveLossCarryforward).mockResolvedValue({ ok: true, data: year as never, created: true })
    const res = await post(body)
    expect(res.status).toBe(201)
    expect(saveLossCarryforward).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ fiscal_period_id: PERIOD, brought_forward: 100_000, source: 'tax_assessment' }),
      { dryRun: false },
    )
  })

  it('answers the preview on a dry run', async () => {
    vi.mocked(saveLossCarryforward).mockResolvedValue({ ok: true, dryRun: true, preview: { carried_forward: 40_000 } })
    const res = await post(body, '?dry_run=true')
    expect(res.status).toBe(200)
    const { body: json } = await parseJsonResponse<{ data: unknown }>(res)
    expect(json.data).toEqual({ carried_forward: 40_000 })
    expect(vi.mocked(saveLossCarryforward).mock.calls[0][2]).toEqual({ dryRun: true })
  })
})

describe('GET /api/bookkeeping/tax-loss-carryforwards/[id]', () => {
  const get = (id: string) =>
    GET_ONE(createMockRequest(`/api/bookkeeping/tax-loss-carryforwards/${id}`), { params: Promise.resolve({ id }) })

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await get('tlc-1')).status).toBe(401)
  })

  it('answers 404 for a year the company does not have', async () => {
    vi.mocked(getLossCarryforward).mockResolvedValue({ ok: false, code: 'LOSS_CARRYFORWARD_NOT_FOUND' })
    expect((await get('nope')).status).toBe(404)
  })

  it('answers the year', async () => {
    vi.mocked(getLossCarryforward).mockResolvedValue({ ok: true, data: year as never })
    const res = await get('tlc-1')
    expect(res.status).toBe(200)
    expect(getLossCarryforward).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), 'tlc-1')
  })
})

describe('GET /api/bookkeeping/tax-loss-carryforwards/proposal', () => {
  const get = (query: string) =>
    GET_PROPOSAL(createMockRequest(`/api/bookkeeping/tax-loss-carryforwards/proposal${query}`), noParams)

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    expect((await get(`?fiscal_period_id=${PERIOD}`)).status).toBe(401)
  })

  it('returns 400 without a fiscal period id', async () => {
    expect((await get('')).status).toBe(400)
    expect((await get('?fiscal_period_id=nope')).status).toBe(400)
    expect(proposeLossCarryforward).not.toHaveBeenCalled()
  })

  it('answers 404 for a fiscal period the company does not have', async () => {
    vi.mocked(proposeLossCarryforward).mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
    expect((await get(`?fiscal_period_id=${PERIOD}`)).status).toBe(404)
  })

  it('answers the candidates and writes nothing', async () => {
    const proposal = { candidates: [{ source: 'ink2_history', amount: 180_000 }], result_before_deficit: 20_000 }
    vi.mocked(proposeLossCarryforward).mockResolvedValue({ ok: true, data: proposal as never })
    const res = await get(`?fiscal_period_id=${PERIOD}`)
    expect(res.status).toBe(200)
    const { body: json } = await parseJsonResponse<{ data: unknown }>(res)
    expect(json.data).toEqual(proposal)
    expect(proposeLossCarryforward).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), PERIOD)
    expect(saveLossCarryforward).not.toHaveBeenCalled()
  })
})
