import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockReplan = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  replanRemainingInstallments: (...args: unknown[]) => mockReplan(...args),
}))

import { PATCH } from '../route'

const PREVIEW = {
  accrual_schedule_id: 'sched-1',
  period_start: '2026-01-01',
  period_end_before: '2026-12-31',
  period_end_after: '2026-12-31',
  release_day_before: null,
  release_day_after: 14,
  remaining_amount: 11000,
  before: [{ period_month: '2026-02-01', amount: 1000, booking_date: '2026-02-01' }],
  after: [{ period_month: '2026-02-01', amount: 1000, booking_date: '2026-02-14' }],
}

describe('PATCH /api/bookkeeping/accruals/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  function replanRequest(body: unknown) {
    return PATCH(
      createMockRequest('/api/bookkeeping/accruals/sched-1', { method: 'PATCH', body }),
      createMockRouteParams({ id: 'sched-1' }),
    )
  }

  it('answers 401 without a signed-in user', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await replanRequest({ release_day: 14 }))

    expect(status).toBe(401)
    expect(mockReplan).not.toHaveBeenCalled()
  })

  it('answers 400 when the body changes nothing or names an impossible day', async () => {
    expect((await parseJsonResponse(await replanRequest({}))).status).toBe(400)
    expect((await parseJsonResponse(await replanRequest({ release_day: 32 }))).status).toBe(400)
    expect((await parseJsonResponse(await replanRequest({ period_end: '2026-13-01' }))).status).toBe(400)
    expect(mockReplan).not.toHaveBeenCalled()
  })

  it('answers 404 ACCRUAL_NOT_FOUND for a schedule the service cannot find', async () => {
    mockReplan.mockResolvedValue({ ok: false, code: 'ACCRUAL_NOT_FOUND' })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await replanRequest({ release_day: 14 }),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('ACCRUAL_NOT_FOUND')
  })

  it('answers a refusal with its reason and the Swedish message naming it', async () => {
    mockReplan.mockResolvedValue({
      ok: false,
      code: 'ACCRUAL_REPLAN_INVALID',
      details: { reason: 'nothing_pending' },
      messageSv: 'Alla månader är redan bokförda, så det finns inget kvar att planera om.',
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; details: unknown } }>(
      await replanRequest({ release_day: 14 }),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCRUAL_REPLAN_INVALID')
    expect(body.error.details).toEqual({ reason: 'nothing_pending' })
    expect(body.error.message).toMatch(/redan bokförda/)
  })

  it('dry run: answers the preview and passes dryRun to the service', async () => {
    mockReplan.mockResolvedValue({ ok: true, dryRun: true, preview: PREVIEW })

    const { status, body } = await parseJsonResponse<{ data: typeof PREVIEW }>(
      await replanRequest({ release_day: 14, dry_run: true }),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual(PREVIEW)
    expect(mockReplan).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      'sched-1',
      { releaseDay: 14 },
      { dryRun: true },
    )
  })

  it('commits a new end and release day and answers the result', async () => {
    mockReplan.mockResolvedValue({ ok: true, data: { ...PREVIEW, posted_now: 1 } })

    const { status, body } = await parseJsonResponse<{ data: { posted_now: number } }>(
      await replanRequest({ period_end: '2027-03-13', release_day: null }),
    )

    expect(status).toBe(200)
    expect(body.data.posted_now).toBe(1)
    expect(mockReplan).toHaveBeenCalledWith(
      expect.anything(),
      'sched-1',
      { periodEnd: '2027-03-13', releaseDay: null },
      { dryRun: false },
    )
  })
})
