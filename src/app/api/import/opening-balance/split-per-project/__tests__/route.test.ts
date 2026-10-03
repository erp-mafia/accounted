import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The rules are unit-tested in lib/import/opening-balance; here the route's
// envelope: auth, validation, the outcome mapped to the dashboard shapes.
const mockPreview = vi.fn()
const mockSplit = vi.fn()
vi.mock('@/lib/import/opening-balance/split-per-project', () => ({
  previewOpeningBalanceSplit: (...args: unknown[]) => mockPreview(...args),
  splitOpeningBalancesPerProject: (...args: unknown[]) => mockSplit(...args),
}))

import { GET, POST } from '../route'

const PERIOD_ID = '550e8400-e29b-41d4-a716-446655440000'
const ROUTE_PARAMS = { params: Promise.resolve({}) }

interface Envelope {
  data?: Record<string, unknown>
  error?: { code: string; message?: string }
}

const get = (query: string) =>
  GET(createMockRequest(`/api/import/opening-balance/split-per-project${query}`, { method: 'GET' }), ROUTE_PARAMS)
const post = (body: unknown) =>
  POST(createMockRequest('/api/import/opening-balance/split-per-project', { method: 'POST', body }), ROUTE_PARAMS)

describe('/api/import/opening-balance/split-per-project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  it('returns 401 without a session, on both methods', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await parseJsonResponse(await get(`?fiscal_period_id=${PERIOD_ID}`))).status).toBe(401)
    expect((await parseJsonResponse(await post({ fiscal_period_id: PERIOD_ID }))).status).toBe(401)
    expect(mockPreview).not.toHaveBeenCalled()
    expect(mockSplit).not.toHaveBeenCalled()
  })

  it('returns 400 for a missing or malformed fiscal_period_id', async () => {
    expect((await parseJsonResponse(await get(''))).status).toBe(400)
    expect((await parseJsonResponse(await post({ fiscal_period_id: 'not-a-uuid' }))).status).toBe(400)
    expect(mockPreview).not.toHaveBeenCalled()
    expect(mockSplit).not.toHaveBeenCalled()
  })

  it('returns 404 for a year that is not the company\'s', async () => {
    mockPreview.mockResolvedValue({ ok: false, code: 'OB_PERIOD_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<Envelope>(await get(`?fiscal_period_id=${PERIOD_ID}`))
    expect(status).toBe(404)
    expect(body.error?.code).toBe('OB_PERIOD_NOT_FOUND')

    mockSplit.mockResolvedValue({ ok: false, code: 'OB_PERIOD_NOT_FOUND' })
    expect((await parseJsonResponse(await post({ fiscal_period_id: PERIOD_ID }))).status).toBe(404)
  })

  it('previews for the active company', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: { fiscal_period_id: PERIOD_ID, accounts_to_change: 1, can_apply: true } })
    const { status, body } = await parseJsonResponse<Envelope>(await get(`?fiscal_period_id=${PERIOD_ID}`))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ accounts_to_change: 1, can_apply: true })
    const [ctx, input] = mockPreview.mock.calls[0] as [{ companyId: string; userId: string }, unknown]
    expect(ctx).toMatchObject({ companyId: 'company-1', userId: 'user-1' })
    expect(input).toEqual({ fiscal_period_id: PERIOD_ID })
  })

  it('applies with the pinned fingerprint and answers the result', async () => {
    mockSplit.mockResolvedValue({
      ok: true,
      data: { fiscal_period_id: PERIOD_ID, journal_entry_id: 'ib-1', applied: true, accounts_changed: ['1470'] },
    })
    const { status, body } = await parseJsonResponse<Envelope>(
      await post({ fiscal_period_id: PERIOD_ID, expected_fingerprint: 'abc123' }),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ applied: true, accounts_changed: ['1470'] })
    expect(mockSplit.mock.calls[0][1]).toEqual({ fiscal_period_id: PERIOD_ID, expected_fingerprint: 'abc123' })
  })

  it('refuses a locked year with the Swedish guidance to unlock it first', async () => {
    mockSplit.mockResolvedValue({ ok: false, code: 'OB_SPLIT_PERIOD_LOCKED' })
    const { status, body } = await parseJsonResponse<Envelope>(await post({ fiscal_period_id: PERIOD_ID }))
    expect(status).toBe(409)
    expect(body.error?.code).toBe('OB_SPLIT_PERIOD_LOCKED')
    expect(body.error?.message).toMatch(/Inställningar › Bokföring › Räkenskapsår › Lås upp/)
  })

  it('refuses a closed year with the guidance to reopen it', async () => {
    mockSplit.mockResolvedValue({ ok: false, code: 'OB_SPLIT_PERIOD_CLOSED' })
    const { status, body } = await parseJsonResponse<Envelope>(await post({ fiscal_period_id: PERIOD_ID }))
    expect(status).toBe(409)
    expect(body.error?.message).toMatch(/Inställningar › Bokföring › Räkenskapsår › Öppna igen/)
  })

  it('passes a composed Swedish message through (unresolved project codes)', async () => {
    mockSplit.mockResolvedValue({
      ok: false,
      code: 'OB_SPLIT_DIMENSION_UNRESOLVED',
      messageSv: 'Följande objekt med saldo finns inte i dimensionsregistret: P7 (dimension 6).',
      details: { unresolved: [{ sie_dim_no: '6', code: 'P7', reason: 'unknown_value', accounts: ['1470'] }] },
    })
    const { status, body } = await parseJsonResponse<Envelope>(await post({ fiscal_period_id: PERIOD_ID }))
    expect(status).toBe(409)
    expect(body.error?.message).toMatch(/P7/)
  })
})
