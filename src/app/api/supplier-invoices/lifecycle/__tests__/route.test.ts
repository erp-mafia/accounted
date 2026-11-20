import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'
import { OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES } from '@/lib/payments/orders/status'

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
    // file items of the invoices with their batch (B is in an open file, C in a cancelled one)
    enqueue({
      data: [
        { supplier_invoice_id: B, batch: { id: 'batch-1', status: 'created', created_at: '2026-09-06T09:00:00Z' } },
        { supplier_invoice_id: C, batch: { id: 'batch-0', status: 'cancelled', created_at: '2026-08-21T09:00:00Z' } },
      ],
    })
    // open bank payment orders: none
    enqueue({ data: [] })
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
    expect(body.data.stages[C].batch).toBeNull()
  })

  it('an open bank payment order puts the invoice in payment, the same step as a file', async () => {
    enqueue({ data: [{ id: A, status: 'approved', approved_at: '2026-09-05T08:00:00Z', is_credit_note: false }] })
    // in no file
    enqueue({ data: [] })
    enqueue({
      data: [
        {
          id: 'order-1',
          supplier_invoice_id: A,
          status: 'awaiting_signature',
          created_at: '2026-09-30T08:00:00Z',
          supplier_invoice_payment_id: null,
          provider_status: 'RCVD',
          provider_error_code: null,
        },
      ],
    })

    const { body } = await parseJsonResponse<{
      data: { stages: Record<string, { stage: string; batch: unknown; payment_order: unknown }> }
    }>(await GET(createMockRequest('/api/supplier-invoices/lifecycle'), { params: Promise.resolve({}) }))

    expect(body.data.stages[A].stage).toBe('in_file')
    expect(body.data.stages[A].batch).toBeNull()
    expect(body.data.stages[A].payment_order).toEqual({
      id: 'order-1',
      status: 'awaiting_signature',
      created_at: '2026-09-30T08:00:00Z',
      provider_status: 'RCVD',
      provider_error_code: null,
    })
  })

  it('a failed, rejected or matched order leaves the invoice; an executed one counts until its debit is matched', async () => {
    enqueue({
      data: [
        { id: A, status: 'approved', approved_at: '2026-09-05T08:00:00Z', is_credit_note: false },
        { id: B, status: 'registered', approved_at: null, is_credit_note: false },
      ],
    })
    enqueue({ data: [] })
    // The read asks for candidate statuses only; isOpenPaymentOrder decides.
    enqueue({
      data: [
        { id: 'order-a', supplier_invoice_id: A, status: 'executed', created_at: '2026-10-01T08:00:00Z', supplier_invoice_payment_id: 'sip-1' },
        { id: 'order-b', supplier_invoice_id: B, status: 'executed', created_at: '2026-10-02T08:00:00Z', supplier_invoice_payment_id: null },
      ],
    })

    const { body } = await parseJsonResponse<{
      data: { stages: Record<string, { stage: string; payment_order: { id: string } | null }> }
    }>(await GET(createMockRequest('/api/supplier-invoices/lifecycle'), { params: Promise.resolve({}) }))

    expect(body.data.stages[A].stage).toBe('approved')
    expect(body.data.stages[A].payment_order).toBeNull()
    expect(body.data.stages[B].stage).toBe('in_file')
    expect(body.data.stages[B].payment_order?.id).toBe('order-b')
    expect(findCalls('payment_orders', 'in')).toContainEqual(['status', OPEN_PAYMENT_ORDER_CANDIDATE_STATUSES])
  })

  // #93: the kontantmetod ladder has no attest step (stagesFor('cash')).
  it('an attested invoice of a kontantmetod company stays registered, its ladder has no attest step', async () => {
    enqueue({
      data: [
        { id: A, status: 'approved', approved_at: '2026-09-05T08:00:00Z', is_credit_note: false },
        { id: B, status: 'overdue', approved_at: '2026-09-05T08:00:00Z', is_credit_note: false },
      ],
    })
    // in no file, no order, nothing paid
    enqueue({ data: [] })
    enqueue({ data: [] })
    // the company's method, read because an invoice carries an attest
    enqueue({ data: { accounting_method: 'cash' } })

    const { body } = await parseJsonResponse<{
      data: { stages: Record<string, { stage: string; approved_at: string | null }>; counts: Record<string, number> }
    }>(await GET(createMockRequest('/api/supplier-invoices/lifecycle'), { params: Promise.resolve({}) }))

    expect(body.data.stages[A].stage).toBe('registered')
    expect(body.data.stages[B].stage).toBe('registered')
    // The attest itself is still reported.
    expect(body.data.stages[A].approved_at).toBe('2026-09-05T08:00:00Z')
    expect(body.data.counts).toMatchObject({ registered: 2, approved: 0 })
    expect(findCalls('company_settings', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('reads no settings when no invoice carries an attest', async () => {
    enqueue({ data: [{ id: A, status: 'registered', approved_at: null, is_credit_note: false }] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    await GET(createMockRequest('/api/supplier-invoices/lifecycle'), { params: Promise.resolve({}) })
    expect(findCalls('company_settings', 'select')).toEqual([])
  })

  it('a paid invoice whose bank row is after the sign-off is paid, not reconciled', async () => {
    enqueue({ data: [{ id: C, status: 'paid', approved_at: null, is_credit_note: false }] })
    // in no file, no order
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'tx-1', supplier_invoice_id: C, date: '2026-09-02', cash_account_id: 'acct-1' }] })
    enqueue({ data: [{ account_key: 'bank:acct-1', through_date: '2026-08-31' }] })

    const { body } = await parseJsonResponse<{ data: { stages: Record<string, { stage: string }> } }>(
      await GET(createMockRequest('/api/supplier-invoices/lifecycle', { searchParams: { ids: C } }), { params: Promise.resolve({}) }),
    )
    expect(body.data.stages[C].stage).toBe('paid')
  })
})
