import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// withRouteContext resolves the session through requireAuth, so the mock must
// return the full { user, supabase, error } shape rather than a bare vi.fn().
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn(),
}))

// The route logs every link to the append-only match log and completes any
// matched inbox underlag. Both are audited side effects, not the unit under
// test: stub them so the assertions stay on the RPC contract mapping.
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))

import { NextResponse } from 'next/server'
import { POST } from '../route'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'

const JE_A = '11111111-1111-4111-8111-111111111111'
const JE_B = '22222222-2222-4222-8222-222222222222'

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/transactions/tx-1/link-vouchers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const TWO_VALID_LINKS = {
  links: [
    { journal_entry_id: JE_A, allocated_amount: -5000 },
    { journal_entry_id: JE_B, allocated_amount: -3000 },
  ],
}

describe('POST /api/transactions/[id]/link-vouchers', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeRequest(TWO_VALID_LINKS), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when the links array is empty', async () => {
    const response = await POST(makeRequest({ links: [] }), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when an allocated_amount is zero', async () => {
    const response = await POST(
      makeRequest({ links: [{ journal_entry_id: JE_A, allocated_amount: 0 }] }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status } = await parseJsonResponse(response)

    // Rejected at the schema layer so the RPC's ZERO_ALLOCATION path is only
    // reachable from non-HTTP callers.
    expect(status).toBe(400)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when a journal_entry_id is not a uuid', async () => {
    const response = await POST(
      makeRequest({ links: [{ journal_entry_id: 'not-a-uuid', allocated_amount: -5000 }] }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when the RPC reports an unknown transaction', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: { ok: false, code: 'LINK_VOUCHERS_TX_NOT_FOUND' },
      error: null,
    })

    const response = await POST(makeRequest(TWO_VALID_LINKS), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(404)
    expect((body as { error: { code: string } }).error.code).toBe('LINK_VOUCHERS_TX_NOT_FOUND')
  })

  it('maps an under-allocation onto the shared BATCH_AMOUNT_BELOW_TX envelope', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: {
        ok: false,
        code: 'BATCH_AMOUNT_BELOW_TX',
        details: { allocated: 5000, tx_amount_abs: 8000 },
      },
      error: null,
    })

    const response = await POST(makeRequest(TWO_VALID_LINKS), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect((body as { error: { code: string } }).error.code).toBe('BATCH_AMOUNT_BELOW_TX')
  })

  it('returns 409 when the transaction is already anchored', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: {
        ok: false,
        code: 'LINK_VOUCHERS_TX_ALREADY_BOOKED',
        details: { via: 'transaction_voucher_links' },
      },
      error: null,
    })

    const response = await POST(makeRequest(TWO_VALID_LINKS), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(409)
    expect((body as { error: { code: string } }).error.code).toBe('LINK_VOUCHERS_TX_ALREADY_BOOKED')
  })

  it('links two verifikat and logs one match event per link', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: {
        ok: true,
        transaction_id: 'tx-1',
        link_count: 2,
        allocated_total: -8000,
        settlement_account: '1930',
        links: [
          { journal_entry_id: JE_A, allocated_amount: -5000, voucher_series: 'A', voucher_number: 1 },
          { journal_entry_id: JE_B, allocated_amount: -3000, voucher_series: 'A', voucher_number: 2 },
        ],
      },
      error: null,
    })

    const response = await POST(makeRequest(TWO_VALID_LINKS), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const data = (body as { data: { link_count: number; allocated_total: number } }).data
    expect(data.link_count).toBe(2)
    expect(data.allocated_total).toBe(-8000)

    expect(mockSupabase.rpc).toHaveBeenCalledWith('link_transaction_to_vouchers', {
      p_transaction_id: 'tx-1',
      p_links: TWO_VALID_LINKS.links,
      p_company_id: 'company-1',
    })

    // BFL 7:1 audit trail: one row per coupled verifikat, not one per request.
    expect(logMatchEvent).toHaveBeenCalledTimes(2)

    // With several targets there is no single verifikat to pin an underlag to.
    expect(propagateUnderlagForBookedTransaction).not.toHaveBeenCalled()
  })

  it('completes matched inbox underlag for the unambiguous single-link case', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: {
        ok: true,
        transaction_id: 'tx-1',
        link_count: 1,
        allocated_total: -5000,
        settlement_account: '1930',
        links: [
          { journal_entry_id: JE_A, allocated_amount: -5000, voucher_series: 'A', voucher_number: 1 },
        ],
      },
      error: null,
    })

    const response = await POST(
      makeRequest({ links: [{ journal_entry_id: JE_A, allocated_amount: -5000 }] }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(propagateUnderlagForBookedTransaction).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'tx-1',
      JE_A,
    )
  })

  it('surfaces a transport-level RPC failure as a structured 500', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    })

    const response = await POST(makeRequest(TWO_VALID_LINKS), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(500)
    expect((body as { error: { code: string } }).error.code).toBe('LINK_VOUCHERS_DB_ERROR')
    // A failed link must never be reported as an audited match.
    expect(logMatchEvent).not.toHaveBeenCalled()
  })
})
