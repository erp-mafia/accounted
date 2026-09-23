import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createQueuedMockSupabase, createMockRouteParams } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
const getCompanyRoleMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
  getCompanyRole: (...args: unknown[]) => getCompanyRoleMock(...args),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: vi.fn().mockResolvedValue({ error: null }),
}))

const findFreeLedgerAccountMock = vi.fn()
vi.mock('@/lib/cash-accounts/service', () => ({
  listForCompany: vi.fn().mockResolvedValue([]),
  findFreeLedgerAccount: (...args: unknown[]) => findFreeLedgerAccountMock(...args),
}))

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

function postReq(body: unknown) {
  return new Request('http://localhost/api/cash-accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/cash-accounts (manual bank account)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'admin', companyId: 'company-1' })
    findFreeLedgerAccountMock.mockResolvedValue('1931')
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await POST(postReq({ name: 'Sparkonto', currency: 'SEK' }), createMockRouteParams({}))).status).toBe(401)
  })

  it('returns 400 on an invalid body: missing name, bad bankgiro, non-19xx ledger', async () => {
    expect((await POST(postReq({ currency: 'SEK' }), createMockRouteParams({}))).status).toBe(400)
    expect((await POST(postReq({ name: 'X', currency: 'SEK', payee: { bankgiro: '12' } }), createMockRouteParams({}))).status).toBe(400)
    expect((await POST(postReq({ name: 'X', currency: 'SEK', ledger_account: '1510' }), createMockRouteParams({}))).status).toBe(400)
    expect((await POST(postReq({ name: 'X', currency: 'SEK', ledger_account: '1910' }), createMockRouteParams({}))).status).toBe(400)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
  })

  it('returns 403 for a member', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    expect((await POST(postReq({ name: 'Sparkonto', currency: 'SEK' }), createMockRouteParams({}))).status).toBe(403)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
  })

  it('creates the account on the next free 19xx slot with the payee fields (happy path)', async () => {
    enqueue({ data: [{ ledger_account: '1930' }] }) // rows the company already holds
    enqueue({ data: { id: 'ca-new', ledger_account: '1931', name: 'Sparkonto', bankgiro: '5050-1234' } })

    const response = await POST(postReq({
      name: 'Sparkonto',
      currency: 'SEK',
      payee: { bankgiro: '5050-1234', plusgiro: '' },
    }), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { id: string; ledger_account: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.ledger_account).toBe('1931')
    expect(findFreeLedgerAccountMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'SEK', new Set(['1930']))
    const [insert] = findCalls('cash_accounts', 'insert')
    expect(insert[0]).toMatchObject({
      company_id: 'company-1',
      ledger_account: '1931',
      currency: 'SEK',
      name: 'Sparkonto',
      source: 'manual',
      invoice_payee: true,
      bankgiro: '5050-1234',
      plusgiro: null,
    })
  })
})
