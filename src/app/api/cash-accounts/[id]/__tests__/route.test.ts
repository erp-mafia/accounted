import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

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

import { PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

const CA_1 = '11111111-1111-4111-8111-111111111111'
const CA_OTHER = '22222222-2222-4222-8222-222222222222'

describe('PATCH /api/cash-accounts/[id] (verifikationsserie per bankkonto)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  function patchReq(body: unknown) {
    return new Request('http://localhost/api/cash-accounts/ca-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

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
  })

  it('payee fields: 403 for a member, no role lookup for a pure voucher_series write', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
    const forbidden = await PATCH(patchReq({ bankgiro: '5050-1055' }), createMockRouteParams({ id: CA_1 }))
    expect(forbidden.status).toBe(403)
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)

    enqueue({ data: { id: CA_1, voucher_series: 'M' } })
    const series = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    expect(series.status).toBe(200)
    expect(getCompanyRoleMock).toHaveBeenCalledTimes(1)
  })

  it('payee fields: 400 on an invalid bankgiro or an unknown key', async () => {
    expect((await PATCH(patchReq({ bankgiro: '12' }), createMockRouteParams({ id: CA_1 }))).status).toBe(400)
    expect((await PATCH(patchReq({ ledger_account: '1931' }), createMockRouteParams({ id: CA_1 }))).status).toBe(400)
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('payee fields: 400 on a PSP clearing account (1686): only 19xx bank accounts print as payee', async () => {
    enqueue({ data: { id: CA_1, ledger_account: '1686' } })
    const response = await PATCH(patchReq({ bankgiro: '5050-1055', invoice_payee: true }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAYEE_ACCOUNT_INVALID')
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('payee fields: owner writes bankgiro, clears plusgiro with "", and flags the account as payee', async () => {
    enqueue({ data: { id: CA_1, ledger_account: '1930' } })
    enqueue({ data: { id: CA_1, bankgiro: '5050-1055', plusgiro: null, invoice_payee: true } })
    const response = await PATCH(
      patchReq({ bankgiro: '5050-1055', plusgiro: '', invoice_payee: true }),
      createMockRouteParams({ id: CA_1 }),
    )
    const { status, body } = await parseJsonResponse<{ data: { bankgiro: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.bankgiro).toBe('5050-1055')
    expect((findCalls('cash_accounts', 'update')[0][0] as Record<string, unknown>)).toMatchObject({ bankgiro: '5050-1055', plusgiro: null, invoice_payee: true })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    expect(response.status).toBe(401)
  })

  it('returns 403 when the caller is a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    expect(response.status).toBe(403)
  })

  it('returns 400 on a malformed series (must be one uppercase letter)', async () => {
    for (const bad of ['m', 'AB', '', 7]) {
      const response = await PATCH(patchReq({ voucher_series: bad }), createMockRouteParams({ id: CA_1 }))
      expect(response.status).toBe(400)
    }
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('returns 400 when voucher_series is missing entirely', async () => {
    const response = await PATCH(patchReq({}), createMockRouteParams({ id: CA_1 }))
    expect(response.status).toBe(400)
  })

  it('returns 404 for an id that is not a UUID, without touching the database', async () => {
    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: 'not-a-uuid' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
  })

  it('returns 404 when the account does not belong to the company', async () => {
    enqueue({ data: null, error: null })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_OTHER }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    const eqCalls = findCalls('cash_accounts', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['id', CA_OTHER])
  })

  it('sets the series and returns the updated account (happy path)', async () => {
    enqueue({ data: { id: 'ca-1', ledger_account: '1931', voucher_series: 'M' }, error: null })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ data: { voucher_series: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series).toBe('M')
    expect(findCalls('cash_accounts', 'update')).toContainEqual([{ voucher_series: 'M' }])
  })

  it('clears the override with null so the account follows the per-type default again', async () => {
    enqueue({ data: { id: 'ca-1', ledger_account: '1931', voucher_series: null }, error: null })

    const response = await PATCH(patchReq({ voucher_series: null }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ data: { voucher_series: string | null } }>(response)

    expect(status).toBe(200)
    expect(body.data.voucher_series).toBeNull()
    expect(findCalls('cash_accounts', 'update')).toContainEqual([{ voucher_series: null }])
  })

  it('maps a database error to the canonical error envelope', async () => {
    enqueue({ data: null, error: { message: 'boom', code: '42P01' } })

    const response = await PATCH(patchReq({ voucher_series: 'M' }), createMockRouteParams({ id: CA_1 }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBeGreaterThanOrEqual(400)
    expect(body.error).toBeDefined()
  })

  describe('enabled toggle (crm#59: let a company disable an unused manual bank account)', () => {
    // Compliance swarm (ISO 27001 A.8.3): enabled is one of the conditions for
    // an account to print as invoice payee, and creating a bank account is
    // owner/admin, so a member must not turn one on or off either.
    it.each([false, true])('returns 403 for a member (enabled: %s), without reading or writing the account', async (enabled) => {
      getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'member', companyId: 'company-1' })
      const response = await PATCH(patchReq({ enabled }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
      expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
    })

    it('returns 404 for an id that is not one of the company\'s bank accounts', async () => {
      enqueue({ data: null }) // existing-row guard lookup
      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(404)
      expect(body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    })

    it('blocks disabling the primary cash account', async () => {
      enqueue({ data: { id: CA_1, is_primary: true, bank_connection_id: null } })
      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(400)
      expect(body.error.code).toBe('CASH_ACCOUNT_DISABLE_PRIMARY')
      expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
    })

    it('blocks disabling an account with an open (unbooked, non-ignored) transaction', async () => {
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: null } }) // existing-row guard lookup
      enqueue({ count: 1 }) // open_bank_rows

      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(400)
      expect(body.error.code).toBe('CASH_ACCOUNT_DISABLE_UNRESOLVED')
      expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
    })

    // Regression (Superagent P2): a fixed row cap on the candidate query could
    // return a page where every row happens to be junction-anchored while a
    // genuinely open row sits past the cap, waving the disable through. The
    // guard is one head count on the view, so there is no page to fall off.
    it('asks open_bank_rows for one head count of this account: no row cap can hide an open row', async () => {
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: null } })
      enqueue({ count: 1 }) // open_bank_rows

      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(400)
      expect(body.error.code).toBe('CASH_ACCOUNT_DISABLE_UNRESOLVED')
      expect(findCalls('open_bank_rows', 'select')).toEqual([['id', { count: 'exact', head: true }]])
      expect(findCalls('open_bank_rows', 'eq')).toEqual([['company_id', 'company-1'], ['cash_account_id', CA_1]])
      expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    })

    it('refuses the disable when the open-row count fails: a guard that did not run lets nothing through', async () => {
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: null } })
      enqueue({ error: { message: 'statement timeout' } }) // open_bank_rows

      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      expect(response.status).toBe(500)
      expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
    })

    it('disables a manual, non-primary account with no open transactions', async () => {
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: null } })
      enqueue({ count: 0 }) // open_bank_rows
      enqueue({ data: { id: CA_1, enabled: false, source: 'manual' } })

      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ data: { enabled: boolean } }>(response)
      expect(status).toBe(200)
      expect(body.data.enabled).toBe(false)
      expect(findCalls('cash_accounts', 'update')).toContainEqual([{ enabled: false }])
    })

    it('re-enabling an account skips the primary and open-work guards', async () => {
      enqueue({ data: { id: CA_1, is_primary: true, bank_connection_id: null } }) // refusal read
      enqueue({ data: { id: CA_1, enabled: true, source: 'manual' } }) // setEnabled update
      const response = await PATCH(patchReq({ enabled: true }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ data: { enabled: boolean } }>(response)
      expect(status).toBe(200)
      expect(body.data.enabled).toBe(true)
      expect(findCalls('transactions', 'select')).toHaveLength(0)
    })

    // Superagent P2: the settings UI hiding the switch is not a boundary. A
    // connection-held account's flag mirrors bank_connections.accounts_data,
    // which the sync reads; flipping only this copy would desync the two.
    it.each([false, true])(
      'answers 409 for an account a bank connection holds (enabled: %s), without writing',
      async (enabled) => {
        enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: 'conn-1' } })
        const response = await PATCH(patchReq({ enabled }), createMockRouteParams({ id: CA_1 }))
        const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
        expect(status).toBe(409)
        expect(body.error.code).toBe('CASH_ACCOUNT_ENABLED_BANK_MANAGED')
        expect(findCalls('cash_accounts', 'update')).toHaveLength(0)
      },
    )

    // The rules are setEnabled()'s UPDATE predicate, not only the read above
    // it: a row that changes between the read and the write (a bank connection
    // claims it, or it is promoted to primary) must not be written.
    it('carries the connection and primary rules in the UPDATE itself', async () => {
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: null } })
      enqueue({ data: [] })
      enqueue({ data: { id: CA_1, enabled: false, source: 'manual' } })
      await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      expect(findCalls('cash_accounts', 'is')).toContainEqual(['bank_connection_id', null])
      expect(findCalls('cash_accounts', 'eq')).toContainEqual(['is_primary', false])
    })

    it('answers 409, not 404, when a bank connection claims the row between the read and the write', async () => {
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: null } }) // refusal read: fine
      enqueue({ data: [] }) // no unbooked candidates
      enqueue({ data: null }) // guarded UPDATE matched nothing
      enqueue({ data: { id: CA_1, is_primary: false, bank_connection_id: 'conn-1' } }) // re-read: claimed
      const response = await PATCH(patchReq({ enabled: false }), createMockRouteParams({ id: CA_1 }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(409)
      expect(body.error.code).toBe('CASH_ACCOUNT_ENABLED_BANK_MANAGED')
    })
  })
})
