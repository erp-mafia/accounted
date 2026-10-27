import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest } from '@/tests/helpers'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('@/lib/bookkeeping/currency-revaluation-monthly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/currency-revaluation-monthly')>()),
  executeMonthlyCurrencyRevaluation: vi.fn(),
}))

import { requireAuth } from '@/lib/auth/require-auth'
import {
  MonthlyRevaluationError,
  executeMonthlyCurrencyRevaluation,
} from '@/lib/bookkeeping/currency-revaluation-monthly'
import { POST } from '../route'

let period: { id: string } | null = { id: 'period-1' }
const supabase = {
  from: vi.fn(() => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'lte', 'gte']) builder[method] = () => builder
    builder.maybeSingle = async () => ({ data: period, error: null })
    return builder
  }),
}

function call(body: unknown) {
  return POST(
    createMockRequest('/api/bookkeeping/currency-revaluation/monthly', { method: 'POST', body }),
    { params: Promise.resolve({}) } as never,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_FX_MONTHLY_REVALUATION_ENABLED', 'true')
  period = { id: 'period-1' }
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null } as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/bookkeeping/currency-revaluation/monthly', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    expect((await call({ month_end: '2026-06-30' })).status).toBe(401)
    expect(executeMonthlyCurrencyRevaluation).not.toHaveBeenCalled()
  })

  it('is closed while the flag is off', async () => {
    vi.stubEnv('NEXT_PUBLIC_FX_MONTHLY_REVALUATION_ENABLED', '')
    const res = await call({ month_end: '2026-06-30' })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('FX_MONTHLY_REVALUATION_DISABLED')
  })

  it('returns 400 for a missing or malformed month end', async () => {
    expect((await call({})).status).toBe(400)
    expect((await call({ month_end: '30/6' })).status).toBe(400)
  })

  it('returns 404 when no financial year covers the month end', async () => {
    period = null
    const res = await call({ month_end: '2026-06-30' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FX_MONTHLY_REVALUATION_NO_PERIOD')
  })

  it('posts the revaluation and answers both verifikat', async () => {
    vi.mocked(executeMonthlyCurrencyRevaluation).mockResolvedValue({
      entry: { id: 'reval-1', voucher_series: 'A', voucher_number: 41 },
      reversal: { id: 'storno-1' },
      preview: { netEffect: 500 },
    } as never)
    const res = await call({ month_end: '2026-06-30' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      journal_entry_id: 'reval-1',
      voucher_series: 'A',
      voucher_number: 41,
      reversal_entry_id: 'storno-1',
      net_effect: 500,
    })
    expect(executeMonthlyCurrencyRevaluation).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', '2026-06-30', 'user-1')
  })

  it('maps the service refusals to their codes', async () => {
    vi.mocked(executeMonthlyCurrencyRevaluation).mockRejectedValue(
      new MonthlyRevaluationError('FX_MONTHLY_REVALUATION_EXISTS', 'finns redan'),
    )
    const res = await call({ month_end: '2026-06-30' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('FX_MONTHLY_REVALUATION_EXISTS')
  })
})
