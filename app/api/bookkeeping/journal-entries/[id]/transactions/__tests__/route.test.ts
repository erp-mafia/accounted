import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueueMany, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

/**
 * The resolver's fixed `.from()` order (see
 * lib/core/bookkeeping/__tests__/journal-entry-transactions.test.ts):
 * transactions, transaction_voucher_links, invoice_payments,
 * supplier_invoice_payments, [transactions by id], skattekonto_transactions.
 */
const NOTHING_LINKED = [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }]

type Body = { data: { transactions: { kind: string; id: string }[] } }

describe('GET /api/bookkeeping/journal-entries/[id]/transactions', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  const run = (id = 'je-1') =>
    GET(
      createMockRequest(`/api/bookkeeping/journal-entries/${id}/transactions`),
      createMockRouteParams({ id }),
    )

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    expect((await run()).status).toBe(401)
  })

  it('returns the skattekonto row the verifikat was booked from', async () => {
    enqueueMany([
      { data: [] }, // transactions
      { data: [] }, // junction
      { data: [] }, // invoice_payments
      { data: [] }, // supplier_invoice_payments
      {
        data: [
          { id: 'skv-1', transaktionsdatum: '2026-09-05', transaktionstext: 'Intäktsränta', belopp_skatteverket: 123 },
        ],
      }, // skattekonto_transactions
    ])

    const { status, body } = await parseJsonResponse<Body>(await run())

    expect(status).toBe(200)
    expect(body.data.transactions).toEqual([
      { kind: 'skattekonto', id: 'skv-1', date: '2026-09-05', description: 'Intäktsränta', amount: 123, currency: null },
    ])
  })

  it('resolves an id outside the active company to an empty list, never a leak', async () => {
    enqueueMany(NOTHING_LINKED)

    const { status, body } = await parseJsonResponse<Body>(await run('je-other'))

    expect(status).toBe(200)
    expect(body.data.transactions).toEqual([])
  })

  it('marks the payload private, no-store: it carries bank descriptions and amounts', async () => {
    enqueueMany(NOTHING_LINKED)

    expect((await run()).headers.get('Cache-Control')).toBe('private, no-store')
  })
})
