import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createMockRouteParams, makeSupplierInvoice } from '@/tests/helpers'

/**
 * Attest of an aged supplier invoice (#1206).
 *
 * The daily cron flips unbooked payables past their due date to 'overdue', so a
 * registered-only approve gate left them with no way through attest at all.
 * approved_at (not the status) is the durable attest marker, which is also what
 * makes approval idempotent and what the overdue un-flip reads.
 *
 * Uses a capturing chain rather than the queued mock so the exact written
 * payload can be asserted. Dates are pinned far in the past/future so the
 * assertions hold whatever the wall-clock date is when the suite runs.
 */

const PAST = '2000-01-01'
const FUTURE = '2999-01-01'

const updatePayloads: Record<string, unknown>[] = []
const singleResults: { data: unknown; error: unknown }[] = []
const mockUser = { id: 'user-1', email: 'test@test.se' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chain: any = {
  select: () => chain,
  update: (payload: Record<string, unknown>) => {
    updatePayloads.push(payload)
    return chain
  },
  eq: () => chain,
  // The write paths pin their compare-and-swap predicates with .in()/.is(),
  // so the chain has to accept them too.
  in: () => chain,
  is: () => chain,
  single: () => Promise.resolve(singleResults.shift() ?? { data: null, error: null }),
  maybeSingle: () => Promise.resolve(singleResults.shift() ?? { data: null, error: null }),
}

const mockSupabase = {
  from: () => chain,
  rpc: () => chain,
  auth: { getUser: vi.fn() },
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { eventBus } from '@/lib/events'

import { POST } from '../route'

describe('POST /api/supplier-invoices/[id]/approve (aged invoices)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updatePayloads.length = 0
    singleResults.length = 0
    // The approve path emits supplier_invoice.approved on the module-level bus;
    // clear it so handlers registered elsewhere cannot leak into this suite.
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  function approveRequest() {
    return POST(
      createMockRequest('/api/supplier-invoices/inv-1/approve', { method: 'POST' }),
      createMockRouteParams({ id: 'inv-1' }),
    )
  }

  it('approves an overdue invoice and keeps the overdue label while it is still late', async () => {
    const invoice = makeSupplierInvoice({
      id: 'inv-1',
      status: 'overdue',
      due_date: PAST,
      remaining_amount: 1000,
    })
    singleResults.push({ data: invoice, error: null })
    singleResults.push({ data: { ...invoice, approved_at: 'now' }, error: null })

    const response = await approveRequest()

    expect(response.status).toBe(200)
    expect(updatePayloads).toHaveLength(1)
    expect(updatePayloads[0].status).toBe('overdue')
    expect(updatePayloads[0].approved_at).toEqual(expect.any(String))
  })

  it('lands on approved when the invoice is no longer past due', async () => {
    const invoice = makeSupplierInvoice({
      id: 'inv-1',
      status: 'overdue',
      due_date: FUTURE,
      remaining_amount: 1000,
    })
    singleResults.push({ data: invoice, error: null })
    singleResults.push({ data: { ...invoice, status: 'approved' }, error: null })

    const response = await approveRequest()

    expect(response.status).toBe(200)
    expect(updatePayloads[0].status).toBe('approved')
  })

  it('stamps approved_at when approving a registered invoice', async () => {
    const invoice = makeSupplierInvoice({ id: 'inv-1', status: 'registered', due_date: FUTURE })
    singleResults.push({ data: invoice, error: null })
    singleResults.push({ data: { ...invoice, status: 'approved' }, error: null })

    const response = await approveRequest()

    expect(response.status).toBe(200)
    expect(updatePayloads[0]).toMatchObject({ status: 'approved' })
    expect(updatePayloads[0].approved_at).toEqual(expect.any(String))
  })

  it('refuses when the optimistic-concurrency update matches no row', async () => {
    // Two approvals in flight: the loser's update finds no row still in a
    // pre-approval state, and must not emit a second approval event.
    const invoice = makeSupplierInvoice({ id: 'inv-1', status: 'registered', due_date: FUTURE })
    singleResults.push({ data: invoice, error: null })
    singleResults.push({ data: null, error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')
    const response = await approveRequest()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_APPROVE_NOT_REGISTERED')
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('refuses a second approval of an already-attested overdue invoice', async () => {
    singleResults.push({
      data: makeSupplierInvoice({
        id: 'inv-1',
        status: 'overdue',
        due_date: PAST,
        remaining_amount: 1000,
        approved_at: '2026-01-01T08:00:00Z',
      }),
      error: null,
    })

    const response = await approveRequest()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_APPROVE_NOT_REGISTERED')
    expect(updatePayloads).toHaveLength(0)
  })
})
