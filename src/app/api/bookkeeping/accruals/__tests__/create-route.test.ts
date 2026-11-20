import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const createManualAccrualSchedule = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/bookkeeping/accruals/manual', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/accruals/manual')>()),
  createManualAccrualSchedule: (...args: unknown[]) => createManualAccrualSchedule(...args),
}))

import { POST } from '../route'

const routeParams = { params: Promise.resolve({}) }
const ENTRY_ID = '11111111-1111-4111-8111-111111111111'
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222'
const INPUT = {
  direction: 'expense', amount_sek: 6000, balance_account: '1730', target_account: '6310',
  period_start: '2026-07-01', months: 6, description: 'Försäkring', origin_journal_entry_id: ENTRY_ID,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

function request(body: unknown) {
  return createMockRequest('/api/bookkeeping/accruals', { method: 'POST', body })
}

describe('POST /api/bookkeeping/accruals', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const { status } = await parseJsonResponse(await POST(request(INPUT), routeParams))
    expect(status).toBe(401)
    expect(createManualAccrualSchedule).not.toHaveBeenCalled()
  })

  it('returns 400 without months or period_end, and for a target outside class 3-8', async () => {
    expect((await parseJsonResponse(await POST(request({ ...INPUT, months: undefined }), routeParams))).status).toBe(400)
    expect((await parseJsonResponse(await POST(request({ ...INPUT, target_account: '1930' }), routeParams))).status).toBe(400)
    expect(createManualAccrualSchedule).not.toHaveBeenCalled()
  })

  it('returns 404 when the origin verifikat is missing', async () => {
    createManualAccrualSchedule.mockResolvedValue({ ok: false, code: 'ACCRUAL_ORIGIN_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await POST(request(INPUT), routeParams))
    expect(status).toBe(404)
    expect(body.error.code).toBe('ACCRUAL_ORIGIN_NOT_FOUND')
  })

  it('returns 400 with what remains when the amount exceeds it', async () => {
    createManualAccrualSchedule.mockResolvedValue({
      ok: false, code: 'ACCRUAL_BALANCE_EXCEEDED', details: { available_sek: 6000 }, messageSv: 'Det finns 6 000,00 kr kvar.',
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { available_sek: number } } }>(
      await POST(request({ ...INPUT, amount_sek: 12000 }), routeParams),
    )
    expect(status).toBe(400)
    expect(body.error).toMatchObject({ code: 'ACCRUAL_BALANCE_EXCEEDED', details: { available_sek: 6000 } })
  })

  it('previews the installments without writing', async () => {
    createManualAccrualSchedule.mockResolvedValue({ ok: true, dryRun: true, preview: { installments: [1, 2, 3, 4, 5, 6], available_sek: 6000 } })

    const { status, body } = await parseJsonResponse<{ data: { installments: unknown[] } }>(
      await POST(request({ ...INPUT, dry_run: true }), routeParams),
    )

    expect(status).toBe(200)
    expect(body.data.installments).toHaveLength(6)
    expect(createManualAccrualSchedule).toHaveBeenCalledWith(expect.anything(), INPUT, { dryRun: true })
  })

  it('creates the manual plan', async () => {
    createManualAccrualSchedule.mockResolvedValue({
      ok: true,
      created: true,
      data: {
        id: SCHEDULE_ID, source_kind: 'manual', direction: 'expense', balance_account: '1730', target_account: '6310',
        total_amount: 6000, period_start: '2026-07-01', period_end: '2026-12-31', months: 6,
        origin_journal_entry_id: ENTRY_ID, posting_floor_date: '2026-01-10',
      },
    })

    const { status, body } = await parseJsonResponse<{ data: { accrual_schedule_id: string; period_end: string } }>(
      await POST(request(INPUT), routeParams),
    )

    expect(status).toBe(201)
    expect(body.data).toMatchObject({ accrual_schedule_id: SCHEDULE_ID, period_end: '2026-12-31' })
    expect(createManualAccrualSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      INPUT,
      { dryRun: false },
    )
  })
})
