import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/mileage/mileage-service', () => ({
  pushMileageToSalaryRun: vi.fn(),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { pushMileageToSalaryRun } from '@/lib/mileage/mileage-service'

const params = { params: Promise.resolve({}) } as never

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const EMPLOYEE_ID = '22222222-2222-4222-8222-222222222222'

function authed() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1' } as never,
    supabase: {} as never,
    error: null,
  } as never)
}

const VALID_BODY = {
  run_id: RUN_ID,
  employee_id: EMPLOYEE_ID,
  from: '2026-05-01',
  to: '2026-05-31',
}

function postReq(body: unknown) {
  return new Request('https://x.test/api/mileage/salary-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/mileage/salary-push', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(401)
    expect(pushMileageToSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 400 without a payroll run', async () => {
    authed()
    const res = await POST(postReq({ ...VALID_BODY, run_id: undefined }), params)
    expect(res.status).toBe(400)
    expect(pushMileageToSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 400 for a period spanning calendar years', async () => {
    authed()
    const res = await POST(postReq({ ...VALID_BODY, from: '2025-12-20', to: '2026-01-10' }), params)
    expect(res.status).toBe(400)
    expect(pushMileageToSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 404 when the payroll run is not in the company', async () => {
    authed()
    vi.mocked(pushMileageToSalaryRun).mockResolvedValue({ ok: false, code: 'RUN_NOT_FOUND' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(404)
  })

  it('returns 404 when the employee is not in the payroll run', async () => {
    authed()
    vi.mocked(pushMileageToSalaryRun).mockResolvedValue({ ok: false, code: 'EMPLOYEE_NOT_IN_RUN' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(404)
  })

  it('returns 409 when the payroll run can no longer change', async () => {
    authed()
    vi.mocked(pushMileageToSalaryRun).mockResolvedValue({ ok: false, code: 'RUN_NOT_EDITABLE' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(409)
  })

  it('returns 400 when the period has no unbooked trips', async () => {
    authed()
    vi.mocked(pushMileageToSalaryRun).mockResolvedValue({ ok: false, code: 'NO_TRIPS' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(400)
  })

  it('adds the trips to the run and returns the summary, unassigned trips included by default', async () => {
    authed()
    vi.mocked(pushMileageToSalaryRun).mockResolvedValue({
      ok: true,
      tripCount: 4,
      totalAmount: 500,
      summaries: [],
    })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ trip_count: 4, total_amount: 500 })
    expect(pushMileageToSalaryRun).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      runId: RUN_ID,
      employeeId: EMPLOYEE_ID,
      from: '2026-05-01',
      to: '2026-05-31',
      includeUnassigned: true,
    })
  })
})
