import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createTableMockSupabase, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, setTable, reset, findCall } = createTableMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_CONNECTION_ID = '22222222-2222-4222-8222-222222222222'

function getReq(query = '') {
  return new Request(`http://localhost/api/cash-accounts/ledger-suggestions${query}`)
}

/** One bank account on 1940 whose unbooked transactions are booked on 1920. */
function seedWrongMapping() {
  setTable('bank_connections', {
    data: [{
      id: CONNECTION_ID,
      bank_name: 'Testbanken',
      status: 'active',
      accounts_data: [{ uid: 'uid-a', iban: 'SE0000000000000000004417', currency: 'SEK', enabled: true }],
    }],
  })
  setTable('cash_accounts', {
    data: [{
      id: 'cash-a',
      ledger_account: '1940',
      bank_connection_id: CONNECTION_ID,
      enabled: true,
      external_uid: 'uid-a',
      iban: 'SE0000000000000000004417',
      name: 'Företagskonto',
      currency: 'SEK',
    }],
  })
  setTable('rpc:cash_account_ledger_evidence', {
    data: [{ cash_account_id: 'cash-a', kind: 'transactions', ledger_account: '1920', hits: 46, balance_date: null }],
  })
  setTable('chart_of_accounts', { data: [{ account_number: '1920', account_name: 'PlusGiro' }] })
  setTable('rpc:cash_account_booked_rows', { data: 3 })
}

describe('GET /api/cash-accounts/ledger-suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' } as never,
      supabase: mockSupabase as never,
      error: null,
    })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(getReq(), createMockRouteParams({}))

    expect(response.status).toBe(401)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 for a connection_id that is not a uuid, and for an unknown parameter', async () => {
    for (const query of ['?connection_id=not-a-uuid', '?company_id=company-2']) {
      const response = await GET(getReq(query), createMockRouteParams({}))
      expect(response.status).toBe(400)
    }
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 for a bank connection the company does not have', async () => {
    seedWrongMapping()

    const response = await GET(getReq(`?connection_id=${OTHER_CONNECTION_ID}`), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    // Scoped to the active company, and no ledger read for a connection that is not there.
    expect(findCall('bank_connections', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('rpc:cash_account_ledger_evidence', 'rpc')).toBeUndefined()
  })

  it('returns an empty list when the books agree with the mapping', async () => {
    seedWrongMapping()
    setTable('rpc:cash_account_ledger_evidence', {
      data: [{ cash_account_id: 'cash-a', kind: 'transactions', ledger_account: '1940', hits: 46, balance_date: null }],
    })

    const { status, body } = await parseJsonResponse<{ data: { suggestions: unknown[] } }>(
      await GET(getReq(), createMockRouteParams({})),
    )

    expect(status).toBe(200)
    expect(body.data.suggestions).toEqual([])
  })

  it('returns the suggestion with the bank picker request that makes the change', async () => {
    seedWrongMapping()

    const response = await GET(getReq(`?connection_id=${CONNECTION_ID}`), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { suggestions: Array<Record<string, unknown>> } }>(response)

    expect(status).toBe(200)
    expect(body.data.suggestions).toEqual([
      {
        id: 'move:cash-a>1920',
        kind: 'move',
        accounts: [{
          cash_account_id: 'cash-a',
          connection_id: CONNECTION_ID,
          uid: 'uid-a',
          label: '••4417',
          from_ledger: '1940',
          from_ledger_name: null,
          to_ledger: '1920',
          to_ledger_name: 'PlusGiro',
          basis: 'transactions',
          hits: 46,
          balance_date: null,
          booked_rows: 3,
        }],
        selection: {
          connection_id: CONNECTION_ID,
          enabled_uids: ['uid-a'],
          account_mappings: [{ uid: 'uid-a', ledger_account: '1920' }],
        },
        one_click: true,
        two_connections: false,
      },
    ])
    expect(findCall('cash_accounts', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('rpc:cash_account_ledger_evidence', 'rpc')).toEqual([{ p_company_id: 'company-1' }])
  })

  it('answers a failed ledger read with the error envelope, not an empty list', async () => {
    seedWrongMapping()
    setTable('rpc:cash_account_ledger_evidence', {
      error: { message: 'canceling statement due to statement timeout', code: '57014' },
    })

    const response = await GET(getReq(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string }; data?: unknown }>(response)

    expect(status).toBeGreaterThanOrEqual(500)
    expect(typeof body.error.code).toBe('string')
    expect(body.data).toBeUndefined()
  })
})
