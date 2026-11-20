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

const syncMappedAccountsMock = vi.fn()
vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: (...args: unknown[]) => syncMappedAccountsMock(...args),
}))

vi.mock('@/lib/cash-accounts/service', () => ({
  listForCompany: vi.fn().mockResolvedValue([]),
  findFreeLedgerAccount: vi.fn(),
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

const CARD = { kind: 'card', name: 'Eurocard Företag', currency: 'SEK', card_issuer: 'eurocard' }

describe('POST /api/cash-accounts (kind card: company card)', () => {
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
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    syncMappedAccountsMock.mockResolvedValue({ error: null })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await POST(postReq(CARD), createMockRouteParams({}))).status).toBe(401)
  })

  it.each([
    ['a bank ledger', { ...CARD, ledger_account: '1930' }],
    ['2893 (skulder till närstående)', { ...CARD, ledger_account: '2893' }],
    ['the supplier payable', { ...CARD, ledger_account: '2440' }],
    ['a number instead of a string', { ...CARD, ledger_account: 2890 }],
    ['three digits as last four', { ...CARD, card_last4: ['366'] }],
    ['letters as last four', { ...CARD, card_last4: ['36a7'] }],
    ['no issuer', { kind: 'card', name: 'Kort', currency: 'SEK' }],
    ['payee details', { ...CARD, payee: { bankgiro: '5050-1234' } }],
    ['printed as payee', { ...CARD, invoice_payee: true }],
    ['an unknown issuer', { ...CARD, card_issuer: 'visa_gold' }],
  ])('returns 400 for %s and writes nothing', async (_label, body) => {
    const response = await POST(postReq(body), createMockRouteParams({}))
    expect(response.status).toBe(400)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
  })

  it('returns 400 for card fields on a bank account', async () => {
    const response = await POST(postReq({ name: 'Sparkonto', currency: 'SEK', card_issuer: 'amex' }), createMockRouteParams({}))
    expect(response.status).toBe(400)
  })

  it('returns 403 for a member and writes nothing', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const response = await POST(postReq(CARD), createMockRouteParams({}))
    expect(response.status).toBe(403)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
  })

  it('returns 409 CASH_ACCOUNT_LEDGER_TAKEN when another account holds the ledger', async () => {
    enqueue({ data: [{ id: 'ca-1', ledger_account: '1930' }, { id: 'ca-2', ledger_account: '2890' }] })
    const response = await POST(postReq({ ...CARD, ledger_account: '2890' }), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('CASH_ACCOUNT_LEDGER_TAKEN')
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
  })

  it('creates the card on the ledger asked for, with the chart row (happy path)', async () => {
    enqueue({ data: [{ id: 'ca-1', ledger_account: '1930' }] })
    enqueue({ data: { id: 'card-1', kind: 'card', ledger_account: '2899', name: 'Eurocard Företag' } })

    const response = await POST(
      postReq({ ...CARD, ledger_account: '2899', card_last4: ['3667', '3667', '1234'], voucher_series: 'K' }),
      createMockRouteParams({}),
    )
    const { status, body } = await parseJsonResponse<{ data: { id: string; ledger_account: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.ledger_account).toBe('2899')
    const [insert] = findCalls('cash_accounts', 'insert')
    expect(insert[0]).toEqual({
      company_id: 'company-1',
      ledger_account: '2899',
      currency: 'SEK',
      name: 'Eurocard Företag',
      kind: 'card',
      card_issuer: 'eurocard',
      card_last4: ['3667', '1234'],
      voucher_series: 'K',
      enabled: true,
      is_primary: false,
      invoice_payee: false,
      source: 'manual',
    })
    // The chart row the ledger needs, named by BAS.
    expect(syncMappedAccountsMock).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1',
      [expect.objectContaining({ sourceAccount: '2899', targetAccount: '2899' })],
      false,
    )
  })

  it('suggests 2890 when no verifikat uses it', async () => {
    enqueue({ data: [{ id: 'ca-1', ledger_account: '1930' }] })
    enqueue({ data: [{ account_number: '1930', usage_count: 40 }, { account_number: '6540', usage_count: 3 }] })
    enqueue({ data: { id: 'card-1', kind: 'card', ledger_account: '2890' } })

    const response = await POST(postReq(CARD), createMockRouteParams({}))
    expect(response.status).toBe(201)
    const [insert] = findCalls('cash_accounts', 'insert')
    expect(insert[0]).toMatchObject({ ledger_account: '2890', kind: 'card' })
  })

  it('suggests 2899 when 2890 already carries other verifikat', async () => {
    enqueue({ data: [{ id: 'ca-1', ledger_account: '1930' }] })
    enqueue({ data: [{ account_number: '2890', usage_count: 12 }] })
    enqueue({ data: { id: 'card-1', kind: 'card', ledger_account: '2899' } })

    const response = await POST(postReq(CARD), createMockRouteParams({}))
    expect(response.status).toBe(201)
    const [insert] = findCalls('cash_accounts', 'insert')
    expect(insert[0]).toMatchObject({ ledger_account: '2899' })
  })

  it('answers 409 when the insert loses a race for the ledger', async () => {
    enqueue({ data: [] })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
    const response = await POST(postReq({ ...CARD, ledger_account: '2890' }), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('CASH_ACCOUNT_LEDGER_TAKEN')
  })
})
