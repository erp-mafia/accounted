/**
 * GET /api/pending-operations/[id]/verifikat: the verifikat approving a
 * proposal would post, for a proposal whose rows are built at the click (a
 * supplier invoice from the inbox), as the card beside its Godkänn asks for
 * them. Only the active company's pending proposals; never cached. The answer
 * itself is approvalVerifikat's (lib/pending-operations/__tests__), and the
 * whole path runs on real Postgres in tests/pg/inbox-approval-verifikat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
const approvalVerifikatMock = vi.fn()
vi.mock('@/lib/pending-operations/approval-verifikat', () => ({
  approvalVerifikat: (...args: unknown[]) => approvalVerifikatMock(...args),
}))

import { GET } from '../route'

const OP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'

const STAGED = {
  id: OP_ID,
  operation_type: 'create_supplier_invoice_from_inbox',
  status: 'pending',
  params: { inbox_item_id: 'item-1', supplier_id: 'supplier-1', total: 1250 },
}

const ANSWER = {
  posts: 'verifikat',
  verifikat: [
    {
      entry_date: '2026-05-15',
      lines: [
        { account_number: '6530', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2641', debit_amount: 250, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 1250 },
      ],
      total_debit: 1250,
      total_credit: 1250,
    },
  ],
}

const get = (id = OP_ID) => GET(createMockRequest(`/api/pending-operations/${id}/verifikat`), createMockRouteParams({ id }))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
  approvalVerifikatMock.mockResolvedValue(ANSWER)
})

describe('GET /api/pending-operations/[id]/verifikat', () => {
  it('returns 401 when not authenticated, and works nothing out', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(approvalVerifikatMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an id that is not a uuid', async () => {
    expect((await get('nope')).status).toBe(400)
    expect(approvalVerifikatMock).not.toHaveBeenCalled()
  })

  it('returns 404 for another company\'s proposal: it is read within the active company only', async () => {
    enqueue({ data: null, error: null })
    const res = await get()
    expect(res.status).toBe(404)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('PENDING_OPERATION_NOT_FOUND')
    expect(findCalls('pending_operations', 'eq')).toEqual([
      ['id', OP_ID],
      ['company_id', 'company-1'],
    ])
    expect(approvalVerifikatMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a proposal whose staged preview states its rows itself, or that posts none', async () => {
    enqueue({ data: { ...STAGED, operation_type: 'categorize_transaction' }, error: null })
    expect((await get()).status).toBe(404)
    enqueue({ data: { ...STAGED, params: { mode: 'register_booked' } }, error: null })
    expect((await get()).status).toBe(404)
    expect(approvalVerifikatMock).not.toHaveBeenCalled()
  })

  it('returns 409 for a proposal that is no longer pending', async () => {
    enqueue({ data: { ...STAGED, status: 'committed' }, error: null })
    const res = await get()
    expect(res.status).toBe(409)
    expect(approvalVerifikatMock).not.toHaveBeenCalled()
  })

  it('answers what the approval would post, worked out for the active company, never cached', async () => {
    enqueue({ data: STAGED, error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const { body } = await parseJsonResponse<{ data: unknown }>(res)
    expect(body.data).toEqual(ANSWER)
    expect(approvalVerifikatMock).toHaveBeenCalledWith(
      expect.objectContaining({ supabase: mockSupabase, companyId: 'company-1', userId: 'user-1' }),
      STAGED.params,
    )
  })
})
