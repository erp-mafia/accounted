import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bokslut/leasing/register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/leasing/register')>()),
  bookFinanceLeaseYear: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import { FinanceLeaseError, bookFinanceLeaseYear } from '@/lib/bokslut/leasing/register'
import { POST } from '../route'

const supabase = {}
const PERIOD = '5b0f8a8e-8d2a-4d4f-9a55-0f0b8b8f6a11'
const post = (payload: unknown) =>
  POST(createMockRequest('/api/bookkeeping/finance-leases/book', { method: 'POST', body: payload }), {
    params: Promise.resolve({}),
  } as never)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_FINANCE_LEASE_ENABLED', 'true')
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/bookkeeping/finance-leases/book', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await post({ fiscal_period_id: PERIOD })).status).toBe(401)
    expect(bookFinanceLeaseYear).not.toHaveBeenCalled()
  })

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_FINANCE_LEASE_ENABLED', '')
    expect((await post({ fiscal_period_id: PERIOD })).status).toBe(503)
  })

  it('returns 400 without a financial year', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ fiscal_period_id: 'not-a-uuid' })).status).toBe(400)
  })

  it('returns 404 for a financial year outside the company', async () => {
    vi.mocked(bookFinanceLeaseYear).mockRejectedValue(new FinanceLeaseError('FINANCE_LEASE_NO_PERIOD'))
    const res = await post({ fiscal_period_id: PERIOD })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FINANCE_LEASE_NO_PERIOD')
  })

  it('maps a year already booked and an unbooked earlier start to 409', async () => {
    vi.mocked(bookFinanceLeaseYear).mockRejectedValueOnce(new FinanceLeaseError('FINANCE_LEASE_YEAR_ALREADY_POSTED'))
    expect((await post({ fiscal_period_id: PERIOD })).status).toBe(409)
    vi.mocked(bookFinanceLeaseYear).mockRejectedValueOnce(
      new FinanceLeaseError('FINANCE_LEASE_START_NOT_BOOKED', { leases: ['Grävmaskin'] }),
    )
    const res = await post({ fiscal_period_id: PERIOD })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('FINANCE_LEASE_START_NOT_BOOKED')
  })

  it('books the year and answers its verifikat', async () => {
    vi.mocked(bookFinanceLeaseYear).mockResolvedValue({
      initialEntries: [{ id: 'start-1', voucher_series: 'A', voucher_number: 7 }],
      yearEndEntry: { id: 'ye-1', voucher_series: 'A', voucher_number: 90 },
    } as never)
    const res = await post({ fiscal_period_id: PERIOD })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      initial_entries: [{ journal_entry_id: 'start-1', voucher_series: 'A', voucher_number: 7 }],
      year_end_entry: { journal_entry_id: 'ye-1', voucher_series: 'A', voucher_number: 90 },
    })
    expect(bookFinanceLeaseYear).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', PERIOD)
  })
})
