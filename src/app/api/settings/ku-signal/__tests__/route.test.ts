/**
 * Tests for /api/settings/ku-signal: ledger-derived kontrolluppgifter signal.
 * The rule itself (interest on an ägarlån, utdelning) is unit-tested in
 * src/lib/tax/__tests__/ku-signal.test.ts; these pin the route around it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const fetchEntryLinesMock = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => fetchEntryLinesMock(...args),
}))

import { GET } from '../route'

/** company_settings answers the entity type; fiscal_periods the closing entries. */
function supabaseWithEntityType(entityType: string | null, closingEntryIds: string[] = []) {
  return {
    from: vi.fn((table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: Record<string, any> = {}
      for (const m of ['select', 'eq', 'not']) chain[m] = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(async () => ({ data: entityType ? { entity_type: entityType } : null }))
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(table === 'fiscal_periods'
          ? { data: closingEntryIds.map((id) => ({ closing_entry_id: id })), error: null }
          : { data: [], error: null })
      return chain
    }),
  }
}

function line(journal_entry_id: string, account_number: string, debit: number, credit: number, entry_date = '2026-06-30') {
  return { journal_entry_id, account_number, debit_amount: debit, credit_amount: credit, journal_entries: { entry_date } }
}

type SignalBody = { data: { has_ku_signal: boolean; triggers: Array<Record<string, unknown>> } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/settings/ku-signal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/settings/ku-signal'), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('reports a KU signal for an ekonomisk förening with vinstutdelning postings, like an aktiebolag', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('ekonomisk_forening'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([line('je-1', '2898', 0, 50000)])
    const { body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/ku-signal'), { params: Promise.resolve({}) }),
    )
    expect(body.data.has_ku_signal).toBe(true)
    expect(body.data.triggers).toEqual([{ kind: 'dividend', account_number: '2898', amount: 50000 }])
  })

  it('names the interest and the loan account when an ägarlån carries interest', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('aktiebolag'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([
      line('je-1', '8410', 1250.5, 0),
      line('je-1', '2393', 0, 1250.5),
    ])

    const { status, body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/ku-signal'), { params: Promise.resolve({}) })
    )
    expect(status).toBe(200)
    expect(body.data.has_ku_signal).toBe(true)
    expect(body.data.triggers).toEqual([{
      kind: 'owner_loan_interest', year: 2026, amount: 1250.5, interest_accounts: ['8410'], loan_accounts: ['2393'],
    }])
    // Posted, non-storno verifikat of this company from the previous calendar year on.
    const { filterEntries } = fetchEntryLinesMock.mock.calls[0][0]
    const calls: Array<[string, unknown[]]> = []
    const q = new Proxy({}, {
      get: (_t, m: string) => (...args: unknown[]) => { calls.push([m, args]); return q },
    })
    filterEntries(q)
    expect(calls).toContainEqual(['eq', ['company_id', 'company-1']])
    expect(calls).toContainEqual(['eq', ['status', 'posted']])
    expect(calls).toContainEqual(['neq', ['source_type', 'storno']])
  })

  it('reports no signal for an interest-free ägarlån (crm#1171)', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('aktiebolag'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([line('je-1', '2393', 0, 4000)])

    const { status, body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/ku-signal'), { params: Promise.resolve({}) })
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ has_ku_signal: false, triggers: [] })
  })

  it('leaves the bokslutsverifikat out', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('aktiebolag', ['je-closing']),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([
      line('je-closing', '8410', 0, 900),
      line('je-closing', '2393', 900, 0),
    ])

    const { body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/ku-signal'), { params: Promise.resolve({}) })
    )
    expect(body.data.has_ku_signal).toBe(false)
  })

  it('never signals for enskild firma, even with matching postings', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithEntityType('enskild_firma'),
      error: null,
    })
    fetchEntryLinesMock.mockResolvedValue([line('je-1', '8410', 500, 0), line('je-1', '2893', 0, 500)])

    const { status, body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/ku-signal'), { params: Promise.resolve({}) })
    )
    expect(status).toBe(200)
    expect(body.data.has_ku_signal).toBe(false)
    // The ledger query is skipped entirely for non-AB companies.
    expect(fetchEntryLinesMock).not.toHaveBeenCalled()
  })
})
