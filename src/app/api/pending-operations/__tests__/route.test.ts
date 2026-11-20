import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const mockAppendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

import { GET } from '../route'

describe('GET /api/pending-operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(
      createMockRequest('/api/pending-operations'),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 for an invalid status', async () => {
    const response = await GET(
      createMockRequest('/api/pending-operations', {
        searchParams: { status: 'bogus' },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('closes a proposal whose bank row is already booked and lists the queue without it', async () => {
    const stale = {
      id: 'operation-1',
      status: 'pending',
      operation_type: 'categorize_transaction',
      risk_level: 'medium',
      params: { transaction_id: 'tx-1', category: 'expense_office' },
    }
    enqueue({ data: [stale], count: 1 }) // first read of the page
    enqueue({ data: [{ id: 'tx-1', is_booked: true }] }) // the row is booked
    enqueue({ data: [{ id: 'operation-1' }] }) // closed as superseded
    enqueue({ data: [], count: 0 }) // the page, read again
    enqueue({ count: 3 })
    enqueue({ count: 5 })

    const response = await GET(
      createMockRequest('/api/pending-operations'),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string }>
      counts: { pending: number; committed: number; rejected: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.counts).toEqual({ pending: 0, committed: 3, rejected: 5 })
    expect(findCalls('pending_operations', 'update')[0][0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
    })
  })

  it('leaves the history tabs alone: nothing is closed from a committed or rejected list', async () => {
    enqueue({ data: [{ id: 'operation-1', status: 'committed', operation_type: 'categorize_transaction', params: { transaction_id: 'tx-1' } }], count: 1 })
    enqueue({ count: 0 })
    enqueue({ count: 0 })

    const response = await GET(
      createMockRequest('/api/pending-operations', { searchParams: { status: 'committed' } }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(supabase.from).toHaveBeenCalledTimes(3)
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })

  it('returns the active list and all tab counts in one response', async () => {
    enqueue({ data: [{ id: 'operation-1', status: 'pending' }], count: 12 })
    enqueue({ count: 3 })
    enqueue({ count: 4 })

    const response = await GET(
      createMockRequest('/api/pending-operations'),
      { params: Promise.resolve({}) },
    )
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string }>
      count: number
      counts: { pending: number; committed: number; rejected: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([{ id: 'operation-1', status: 'pending' }])
    expect(body.count).toBe(12)
    expect(body.counts).toEqual({ pending: 12, committed: 3, rejected: 4 })
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  // crm#1923: a voucher staged into a locked period waited in the queue
  // looking approvable; approving it was refused and closed the proposal.
  it('tells the queue which waiting proposals a period lock stops, read now and not from the stored row', async () => {
    const lockedVoucher = {
      id: 'operation-locked',
      status: 'pending',
      operation_type: 'create_voucher',
      params: { entry_date: '2026-10-05' },
      preview_data: { entry_date: '2026-10-05', total_debit: 1200 },
    }
    const openVoucher = {
      id: 'operation-open',
      status: 'pending',
      operation_type: 'create_voucher',
      params: { entry_date: '2026-11-03' },
      preview_data: { entry_date: '2026-11-03', total_debit: 800 },
    }
    enqueue({ data: [lockedVoucher, openVoucher], count: 2 })
    enqueue({ count: 0 })
    enqueue({ count: 0 })
    enqueue({ data: { bookkeeping_locked_through: '2026-10-31' } }) // company_settings
    enqueue({
      data: [{ id: 'fp-2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }],
    }) // fiscal_periods

    const response = await GET(createMockRequest('/api/pending-operations'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string; preview_data: Record<string, unknown> }>
    }>(response)

    expect(status).toBe(200)
    expect(body.data[0].preview_data).toEqual({
      entry_date: '2026-10-05',
      total_debit: 1200,
      period_status: { period_id: 'fp-2026', status: 'locked', lock_date: '2026-10-31', date: '2026-10-05' },
    })
    expect(body.data[1].preview_data).toEqual(openVoucher.preview_data)
    expect(findCalls('company_settings', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('fiscal_periods', 'eq')).toEqual([['company_id', 'company-1']])
    // Read only: nothing about the lock is written to the proposal.
    expect(findCalls('pending_operations', 'update')).toEqual([])
  })

  it('reads no period locks for the history tabs: a resolved proposal is not waiting on one', async () => {
    enqueue({
      data: [{ id: 'operation-1', status: 'committed', operation_type: 'create_voucher', params: { entry_date: '2026-10-05' } }],
      count: 1,
    })
    enqueue({ count: 0 })
    enqueue({ count: 0 })

    const response = await GET(
      createMockRequest('/api/pending-operations', { searchParams: { status: 'committed' } }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(supabase.from).toHaveBeenCalledTimes(3)
  })

  it('orders the pending queue oldest-first when order=asc is given', async () => {
    enqueue({ data: [{ id: 'operation-old', status: 'pending' }], count: 1 })
    enqueue({ count: 0 })
    enqueue({ count: 0 })

    const response = await GET(
      createMockRequest('/api/pending-operations', { searchParams: { status: 'pending', order: 'asc' } }),
      { params: Promise.resolve({}) },
    )
    expect(response.status).toBe(200)
    const orderCalls = findCalls('pending_operations', 'order')
    expect(orderCalls[0]).toEqual(['created_at', { ascending: true, nullsFirst: false }])
  })

  it('defaults to newest-first and rejects an unknown order with 400', async () => {
    enqueue({ data: [], count: 0 })
    enqueue({ count: 0 })
    enqueue({ count: 0 })
    await GET(createMockRequest('/api/pending-operations'), { params: Promise.resolve({}) })
    expect(findCalls('pending_operations', 'order')[0]).toEqual([
      'created_at',
      { ascending: false, nullsFirst: false },
    ])

    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    const bad = await GET(
      createMockRequest('/api/pending-operations', { searchParams: { order: 'sideways' } }),
      { params: Promise.resolve({}) },
    )
    expect(bad.status).toBe(400)
  })

  it('pages by offset over a total order, so a bulk resolution sharing one resolved_at neither repeats nor drops rows', async () => {
    enqueue({ data: [], count: 120 })
    enqueue({ count: 0 })
    enqueue({ count: 0 })

    const response = await GET(
      createMockRequest('/api/pending-operations', {
        searchParams: { status: 'committed', limit: '50', offset: '50' },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(findCalls('pending_operations', 'order')).toEqual([
      ['resolved_at', { ascending: false, nullsFirst: false }],
      ['id', { ascending: false }],
    ])
    expect(findCalls('pending_operations', 'range')).toEqual([[50, 99]])
  })

  it('returns 500 when the list query fails', async () => {
    enqueue({ error: { message: 'database unavailable' } })
    enqueue({ count: 0 })
    enqueue({ count: 0 })

    const response = await GET(
      createMockRequest('/api/pending-operations'),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(500)
  })
})
