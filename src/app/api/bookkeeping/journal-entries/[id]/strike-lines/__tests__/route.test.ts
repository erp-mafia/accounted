/**
 * Tests for POST /api/bookkeeping/journal-entries/[id]/strike-lines
 * (inline line rättelse of a posted verifikat via the audited RPC).
 *
 * Covers: 401, validation 400 (empty rättelse / bad account / bad uuid),
 * rule-violation 409 passthrough (Swedish RPC messages verbatim), tenant
 * guard 403, unexpected RPC failure 500, the happy path (incl. BAS account
 * backfill before the RPC) and the strike-only path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const rpcMock = vi.fn()
;(supabase as { rpc?: unknown }).rpc = rpcMock

const backfillMock = vi.fn().mockResolvedValue([])
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => backfillMock(...args),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'

const LINE_ID = '11111111-1111-4111-8111-111111111111'

const params = () => createMockRouteParams({ id: 'entry-1' })

function makeRequest(body: unknown) {
  return createMockRequest('/api/bookkeeping/journal-entries/entry-1/strike-lines', {
    method: 'POST',
    body,
  })
}

describe('POST /api/bookkeeping/journal-entries/[id]/strike-lines', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    backfillMock.mockResolvedValue([])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeRequest({ strike_line_ids: [LINE_ID] }), params())
    expect(response.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it.each([
    ['empty rättelse', { strike_line_ids: [], lines: [] }],
    ['bad line id', { strike_line_ids: ['not-a-uuid'] }],
    ['bad account number', { lines: [{ account_number: '19', debit_amount: 100 }] }],
    ['negative amount', { lines: [{ account_number: '1930', debit_amount: -5 }] }],
  ])('rejects invalid body (%s) with 400', async (_label, body) => {
    const response = await POST(makeRequest(body), params())
    expect(response.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('passes rule violations through as 409 with the Swedish message', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Verifikationen balanserar inte efter rättelsen (debet 100.00, kredit 0.00).' },
    })

    const response = await POST(makeRequest({ strike_line_ids: [LINE_ID] }), params())
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(409)
    expect(body.error).toContain('balanserar')
  })

  it('maps the tenant guard (42501) to 403', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'unauthorized: caller is not a member of company company-1' },
    })

    const response = await POST(makeRequest({ strike_line_ids: [LINE_ID] }), params())
    expect(response.status).toBe(403)
  })

  it('returns 500 on unexpected RPC failure', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '57P01', message: 'connection refused' } })

    const response = await POST(makeRequest({ strike_line_ids: [LINE_ID] }), params())
    expect(response.status).toBe(500)
  })

  it('strikes and replaces via the RPC, backfilling BAS accounts first (happy path)', async () => {
    rpcMock.mockResolvedValue({
      data: { log_id: 'log-1', struck_count: 1, added_count: 1, total_debit: 500, total_credit: 500 },
      error: null,
    })

    const response = await POST(
      makeRequest({
        strike_line_ids: [LINE_ID],
        lines: [{ account_number: '5420', debit_amount: 500, line_description: 'Programvara' }],
      }),
      params(),
    )
    const { body } = await parseJsonResponse<{ data: { struck_count: number; added_count: number } }>(response)

    expect(response.status).toBe(200)
    expect(body.data.struck_count).toBe(1)
    expect(body.data.added_count).toBe(1)
    expect(backfillMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', ['5420'])
    expect(rpcMock).toHaveBeenCalledWith('correct_entry_lines_inline', {
      p_company_id: 'company-1',
      p_entry_id: 'entry-1',
      p_strike_line_ids: [LINE_ID],
      p_new_lines: [
        {
          account_number: '5420',
          debit_amount: 500,
          credit_amount: 0,
          line_description: 'Programvara',
          dimensions: {},
        },
      ],
      p_user_id: 'user-1',
    })
  })

  it('accepts a strike-only rättelse without new lines (skips backfill)', async () => {
    rpcMock.mockResolvedValue({
      data: { log_id: 'log-2', struck_count: 2, added_count: 0, total_debit: 100, total_credit: 100 },
      error: null,
    })

    const response = await POST(
      makeRequest({ strike_line_ids: [LINE_ID, '22222222-2222-4222-8222-222222222222'] }),
      params(),
    )

    expect(response.status).toBe(200)
    expect(backfillMock).not.toHaveBeenCalled()
    expect(rpcMock).toHaveBeenCalledWith(
      'correct_entry_lines_inline',
      expect.objectContaining({ p_new_lines: [] }),
    )
  })
})
