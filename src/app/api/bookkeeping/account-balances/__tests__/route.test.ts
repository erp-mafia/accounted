import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/reports/opening-balances', () => ({
  getOpeningBalances: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { GET } from '../route'

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/bookkeeping/account-balances', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getOpeningBalances).mockResolvedValue({
    balances: new Map(),
    obEntryId: null,
  })
})

describe('GET /api/bookkeeping/account-balances', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    expect((await GET(request({ accounts: '1930', as_of: '2026-06-30' }), {
      params: Promise.resolve({}),
    })).status).toBe(401)
  })

  it('returns 400 for an invalid account number', async () => {
    const { supabase } = createQueuedMockSupabase()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    expect((await GET(request({ accounts: 'not-an-account', as_of: '2026-06-30' }), {
      params: Promise.resolve({}),
    })).status).toBe(400)
  })

  it('returns zero balances when no fiscal period contains the date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const { status, body } = await parseJsonResponse<{
      data: Array<{ account_number: string; balance: number }>
    }>(await GET(request({ accounts: '1930', as_of: '2026-06-30' }), {
      params: Promise.resolve({}),
    }))

    expect(status).toBe(200)
    expect(body.data).toEqual([{ account_number: '1930', balance: 0 }])
  })

  it('combines opening balances with aggregated period activity', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          id: 'period-1',
          period_start: '2026-01-01',
          period_end: '2026-12-31',
          opening_balance_entry_id: 'opening-1',
        },
      },
      { data: [{ account_number: '1930', account_class: 1 }] },
      { data: [{ account_number: '1930', debit: 250, credit: 50 }] },
    ])
    vi.mocked(getOpeningBalances).mockResolvedValue({
      balances: new Map([['1930', { debit: 1_000, credit: 0 }]]),
      obEntryId: 'opening-1',
    })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const { status, body } = await parseJsonResponse<{
      data: Array<{ account_number: string; balance: number }>
    }>(await GET(request({ accounts: '1930', as_of: '2026-06-30' }), {
      params: Promise.resolve({}),
    }))

    expect(status).toBe(200)
    expect(body.data).toEqual([{ account_number: '1930', balance: 1_200 }])
    expect(supabase.rpc).toHaveBeenCalledWith('get_account_period_activity', {
      p_company_id: 'company-1',
      p_start: '2026-01-01',
      p_end: '2026-06-30',
      p_accounts: ['1930'],
      p_exclude_journal_entry_id: 'opening-1',
    })
  })
})
