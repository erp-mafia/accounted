import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
})

describe('GET /api/supplier-invoices/lifecycle', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(createMockRequest('/api/supplier-invoices/lifecycle'), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('rejects malformed ids', async () => {
    const res = await GET(
      createMockRequest('/api/supplier-invoices/lifecycle', { searchParams: { ids: 'nope' } }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('derives the stage from status, approval, open batches and sign-offs', async () => {
    // invoices
    enqueue({
      data: [
        { id: A, status: 'registered', approved_at: null, is_credit_note: false },
        { id: B, status: 'approved', approved_at: '2026-09-05T08:00:00Z', is_credit_note: false },
        { id: C, status: 'paid', approved_at: '2026-08-20T08:00:00Z', is_credit_note: false },
      ],
    })
    // open batches, then their items (B is in the batch)
    enqueue({ data: [{ id: 'batch-1', created_at: '2026-09-06T09:00:00Z' }] })
    enqueue({ data: [{ batch_id: 'batch-1', supplier_invoice_id: B }] })
    // paying rows for C, then sign-offs that cover them
    enqueue({ data: [{ id: 'tx-1', supplier_invoice_id: C, date: '2026-08-28', cash_account_id: 'acct-1' }] })
    enqueue({ data: [{ account_key: 'bank:acct-1', through_date: '2026-08-31' }] })

    const { status, body } = await parseJsonResponse<{
      data: { stages: Record<string, { stage: string; batch: unknown; paid: unknown; reconciled_through: string | null }>; counts: Record<string, number> }
    }>(await GET(createMockRequest('/api/supplier-invoices/lifecycle'), { params: Promise.resolve({}) }))

    expect(status).toBe(200)
    expect(body.data.stages[A].stage).toBe('registered')
    expect(body.data.stages[B].stage).toBe('in_file')
    expect(body.data.stages[B].batch).toEqual({ id: 'batch-1', created_at: '2026-09-06T09:00:00Z' })
    expect(body.data.stages[C].stage).toBe('reconciled')
    expect(body.data.stages[C].paid).toEqual({ transaction_id: 'tx-1', date: '2026-08-28' })
    expect(body.data.stages[C].reconciled_through).toBe('2026-08-31')
    expect(body.data.counts).toMatchObject({ registered: 1, in_file: 1, reconciled: 1, paid: 0 })
  })

  it('a paid invoice whose bank row is after the sign-off is paid, not reconciled', async () => {
    enqueue({ data: [{ id: C, status: 'paid', approved_at: null, is_credit_note: false }] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'tx-1', supplier_invoice_id: C, date: '2026-09-02', cash_account_id: 'acct-1' }] })
    enqueue({ data: [{ account_key: 'bank:acct-1', through_date: '2026-08-31' }] })

    const { body } = await parseJsonResponse<{ data: { stages: Record<string, { stage: string }> } }>(
      await GET(createMockRequest('/api/supplier-invoices/lifecycle', { searchParams: { ids: C } }), { params: Promise.resolve({}) }),
    )
    expect(body.data.stages[C].stage).toBe('paid')
  })
})
