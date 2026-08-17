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
  bookMileagePeriod: vi.fn(),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { bookMileagePeriod } from '@/lib/mileage/mileage-service'

const params = { params: Promise.resolve({}) } as never

function authed() {
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1' } as never,
    supabase: {} as never,
    error: null,
  } as never)
}

const VALID_BODY = {
  from: '2026-05-01',
  to: '2026-05-31',
  entry_date: '2026-05-31',
  counter_account: '2820',
}

function postReq(body: unknown) {
  return new Request('https://x.test/api/mileage/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/mileage/book', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(401)
  })

  it('returns 400 on an inverted date range', async () => {
    authed()
    const res = await POST(postReq({ ...VALID_BODY, from: '2026-06-01' }), params)
    expect(res.status).toBe(400)
    expect(bookMileagePeriod).not.toHaveBeenCalled()
  })

  it('returns 400 when the period has no unbooked trips', async () => {
    authed()
    vi.mocked(bookMileagePeriod).mockResolvedValue({ ok: false, code: 'NO_TRIPS' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a period spanning calendar years', async () => {
    authed()
    const res = await POST(
      postReq({ ...VALID_BODY, from: '2025-12-20', to: '2026-01-10', entry_date: '2026-01-10' }),
      params
    )
    expect(res.status).toBe(400)
    expect(bookMileagePeriod).not.toHaveBeenCalled()
  })

  it('returns 409 when a concurrent booking claimed the trips first', async () => {
    authed()
    vi.mocked(bookMileagePeriod).mockResolvedValue({ ok: false, code: 'CLAIM_LOST' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(409)
  })

  it('returns 400 when the period spans several employees', async () => {
    authed()
    vi.mocked(bookMileagePeriod).mockResolvedValue({ ok: false, code: 'MIXED_EMPLOYEES' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('per anställd')
  })

  it('returns 400 when the entry date is in a locked period', async () => {
    authed()
    vi.mocked(bookMileagePeriod).mockResolvedValue({ ok: false, code: 'PERIOD_NOT_OPEN' })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(400)
  })

  it('returns the verifikat summary on success', async () => {
    authed()
    vi.mocked(bookMileagePeriod).mockResolvedValue({
      ok: true,
      journalEntryId: 'je-1',
      voucherNumber: 42,
      voucherSeries: 'A',
      tripCount: 3,
      totalAmount: 297.5,
      summaries: [],
    })
    const res = await POST(postReq(VALID_BODY), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      journal_entry_id: 'je-1',
      voucher_number: 42,
      voucher_series: 'A',
      trip_count: 3,
      total_amount: 297.5,
    })
  })
})
