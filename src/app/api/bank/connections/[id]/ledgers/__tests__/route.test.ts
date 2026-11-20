import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
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

const changeMock = vi.fn()
vi.mock('@/lib/cash-accounts/ledger-change', () => ({
  changeBankAccountLedgers: (...args: unknown[]) => changeMock(...args),
}))

import { PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CONNECTION = '22222222-2222-4222-8222-222222222222'
const MOVE = {
  uid: 'uid-pg',
  name: 'Plusgirokonto',
  iban_last4: '4308',
  currency: 'SEK',
  cash_account_id: 'cash-1',
  from_ledger: '1931',
  to_ledger: '1920',
  booked_rows: 0,
  unbooked_rows: 41,
  swapped: false,
}

type ErrorBody = { error: { code: string; message: string } }

function patch(body: unknown, query = '', id = CONNECTION) {
  return [
    new Request(`http://localhost/api/bank/connections/${id}/ledgers${query}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    createMockRouteParams({ id }),
  ] as const
}

const BODY = { accounts: [{ uid: 'uid-pg', ledger_account: '1920' }] }

describe('PATCH /api/bank/connections/[id]/ledgers (crm#1395: change a bank account\'s ledger account on any connection)', () => {
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
    const response = await PATCH(...patch(BODY))
    expect(response.status).toBe(401)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'viewer', companyId: 'company-1' })
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }) })
    const response = await PATCH(...patch(BODY))
    expect(response.status).toBe(403)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it.each([
    ['no accounts', { accounts: [] }],
    ['a ledger account that is not an account number', { accounts: [{ uid: 'uid-pg', ledger_account: '19x0' }] }],
    ['an account number as a number', { accounts: [{ uid: 'uid-pg', ledger_account: 1920 }] }],
    ['an unknown field', { accounts: [{ uid: 'uid-pg', ledger_account: '1920', enabled: true }] }],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await PATCH(...patch(body))
    expect(response.status).toBe(400)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('answers 400 when the service refuses a ledger account outside the bank accounts (19xx)', async () => {
    changeMock.mockResolvedValue({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'ledger_account', reason: 'not_a_bank_account' } })
    const response = await PATCH(...patch({ accounts: [{ uid: 'uid-pg', ledger_account: '3001' }] }))
    expect(response.status).toBe(400)
  })

  it('returns 400 on a dry_run that is not true/false', async () => {
    const response = await PATCH(...patch(BODY, '?dry_run=yes'))
    expect(response.status).toBe(400)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a non-UUID connection id without calling the service', async () => {
    const response = await PATCH(...patch(BODY, '', 'not-a-uuid'))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the company has no such connection', async () => {
    changeMock.mockResolvedValue({ ok: false, code: 'NOT_FOUND' })
    const response = await PATCH(...patch(BODY))
    expect(response.status).toBe(404)
  })

  it('answers the preview on a dry run', async () => {
    changeMock.mockResolvedValue({ ok: true, dryRun: true, preview: { connection_id: CONNECTION, moves: [MOVE] } })
    const response = await PATCH(...patch(BODY, '?dry_run=true'))
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({ connection_id: CONNECTION, moves: [MOVE] })
    expect(changeMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      { connectionId: CONNECTION, accounts: [{ uid: 'uid-pg', ledger_account: '1920' }] },
      { dryRun: true },
    )
  })

  it('changes the ledger account and answers the moves', async () => {
    changeMock.mockResolvedValue({ ok: true, data: { connection_id: CONNECTION, moves: [MOVE] } })
    const response = await PATCH(...patch(BODY))
    const { status, body } = await parseJsonResponse<{ data: { moves: unknown[] } }>(response)
    expect(status).toBe(200)
    expect(body.data.moves).toEqual([MOVE])
    expect(changeMock.mock.calls[0][2]).toEqual({ dryRun: false })
  })

  it('answers a refusal in the canonical envelope with its Swedish sentence', async () => {
    changeMock.mockResolvedValue({ ok: false, code: 'BANK_LEDGER_CHANGE_NOT_ACTIVE' })
    const response = await PATCH(...patch(BODY))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('BANK_LEDGER_CHANGE_NOT_ACTIVE')
    expect(body.error.message).toContain('inte aktiv')
  })
})
