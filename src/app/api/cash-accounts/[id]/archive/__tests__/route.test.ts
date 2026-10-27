import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
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

import { POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CA_1930 = '22222222-2222-4222-8222-222222222222'

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } }

/**
 * PH 222: a mistakenly connected account that removal must keep (its ledger
 * holds the company's own history, or a row on it was booked) is archived
 * instead: turned off, every row kept.
 */
describe('POST /api/cash-accounts/[id]/archive', () => {
  function archiveReq(query = '') {
    return new Request(`http://localhost/api/cash-accounts/${CA_1930}/archive${query}`, { method: 'POST' })
  }
  const rpcCalls = () => mockSupabase.rpc.mock.calls

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' } as never,
      supabase: mockSupabase as never,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(archiveReq(), createMockRouteParams({ id: CA_1930 }))
    expect(response.status).toBe(401)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 403 for a member, without calling the RPC', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const response = await POST(archiveReq(), createMockRouteParams({ id: CA_1930 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 400 on an unknown query parameter', async () => {
    expect((await POST(archiveReq('?dry_run=yes'), createMockRouteParams({ id: CA_1930 }))).status).toBe(400)
    expect((await POST(archiveReq('?force=true'), createMockRouteParams({ id: CA_1930 }))).status).toBe(400)
    expect(rpcCalls()).toHaveLength(0)
  })

  it('returns 404 for a non-UUID id and for an account the RPC does not find', async () => {
    expect((await POST(archiveReq(), createMockRouteParams({ id: 'nope' }))).status).toBe(404)
    expect(rpcCalls()).toHaveLength(0)
    enqueue({ data: { ok: false, reason: 'not_found' } })
    const response = await POST(archiveReq(), createMockRouteParams({ id: CA_1930 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
  })

  it.each([
    ['primary', 'CASH_ACCOUNT_REMOVE_PRIMARY', /Gör primärt/],
    ['bank_connected', 'CASH_ACCOUNT_REMOVE_BANK_CONNECTED', /Koppla från/],
    ['invoice_payee', 'CASH_ACCOUNT_ARCHIVE_INVOICE_PAYEE', /fakturor/],
    ['removable', 'CASH_ACCOUNT_ARCHIVE_REMOVABLE', /Ta bort/],
    ['already_archived', 'CASH_ACCOUNT_ARCHIVE_ALREADY', /arkiverat/],
  ])('maps the refusal %s to 409 %s with the way out', async (reason, code, message) => {
    enqueue({ data: { ok: false, reason } })
    const response = await POST(archiveReq(), createMockRouteParams({ id: CA_1930 }))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe(code)
    expect(body.error.message).toMatch(message)
    expect(body.error.details).toMatchObject({ cash_account_id: CA_1930, reason })
  })

  it('archives the account and answers why it was kept; the actor is the session user', async () => {
    enqueue({
      data: {
        ok: true,
        dry_run: false,
        cash_account_id: CA_1930,
        ledger_account: '1930',
        kept_because: 'ledger_history',
        open_transactions: 11,
      },
    })
    const response = await POST(archiveReq(), createMockRouteParams({ id: CA_1930 }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      cash_account_id: CA_1930,
      ledger_account: '1930',
      kept_because: 'ledger_history',
      open_transactions: 11,
    })
    expect(rpcCalls()).toEqual([
      [
        'archive_cash_account',
        { p_company_id: 'company-1', p_cash_account_id: CA_1930, p_user_id: 'user-1', p_dry_run: false },
      ],
    ])
  })

  it('dry_run=true previews and passes the flag', async () => {
    enqueue({
      data: { ok: true, dry_run: true, cash_account_id: CA_1930, ledger_account: '1930', kept_because: 'booked', open_transactions: 3 },
    })
    const response = await POST(archiveReq('?dry_run=true'), createMockRouteParams({ id: CA_1930 }))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ kept_because: 'booked', open_transactions: 3 })
    expect(rpcCalls()[0][1]).toMatchObject({ p_dry_run: true })
  })

  it("the database's own owner/admin check answers 403", async () => {
    enqueue({ error: { code: '42501', message: 'CASH_ACCOUNT_ARCHIVE_ADMIN_ONLY' } })
    const response = await POST(archiveReq(), createMockRouteParams({ id: CA_1930 }))
    expect(response.status).toBe(403)
  })
})
