import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const cancelManualSchedule = vi.fn()
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
  cancelManualSchedule: (...args: unknown[]) => cancelManualSchedule(...args),
}))

import { POST } from '../cancel/route'

const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

function cancel(body: unknown, id = SCHEDULE_ID) {
  return POST(
    createMockRequest(`/api/bookkeeping/accruals/${id}/cancel`, { method: 'POST', body }),
    createMockRouteParams({ id }),
  )
}

describe('POST /api/bookkeeping/accruals/[id]/cancel', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await parseJsonResponse(await cancel({}))).status).toBe(401)
    expect(cancelManualSchedule).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid body', async () => {
    expect((await parseJsonResponse(await cancel({ dry_run: 'yes' }))).status).toBe(400)
    expect(cancelManualSchedule).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown or malformed schedule id', async () => {
    cancelManualSchedule.mockResolvedValue({ ok: false, code: 'ACCRUAL_NOT_FOUND' })
    expect((await parseJsonResponse(await cancel({}))).status).toBe(404)
    expect((await parseJsonResponse(await cancel({}, 'not-a-uuid'))).status).toBe(404)
    expect(cancelManualSchedule).toHaveBeenCalledTimes(1)
  })

  it('refuses an invoice plan with 400', async () => {
    cancelManualSchedule.mockResolvedValue({ ok: false, code: 'ACCRUAL_CANCEL_NOT_MANUAL' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await cancel({}))
    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCRUAL_CANCEL_NOT_MANUAL')
  })

  it('previews the months without writing', async () => {
    cancelManualSchedule.mockResolvedValue({ ok: true, dryRun: true, preview: { cancel_months: ['2026-09-01'], reversed_amount: 2000 } })
    const { status, body } = await parseJsonResponse<{ data: { reversed_amount: number } }>(await cancel({ dry_run: true }))
    expect(status).toBe(200)
    expect(body.data.reversed_amount).toBe(2000)
    expect(cancelManualSchedule).toHaveBeenCalledWith(expect.anything(), SCHEDULE_ID, { dryRun: true })
  })

  it('undoes the plan', async () => {
    const data = { accrual_schedule_id: SCHEDULE_ID, status: 'cancelled', cancelled_months: 1, reversed_entries: 2, failed_reversals: 0 }
    cancelManualSchedule.mockResolvedValue({ ok: true, data })
    const { status, body } = await parseJsonResponse<{ data: typeof data }>(await cancel({}))
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    expect(cancelManualSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      SCHEDULE_ID,
      { dryRun: false },
    )
  })
})
