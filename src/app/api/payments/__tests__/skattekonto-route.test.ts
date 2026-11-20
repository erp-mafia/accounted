import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const prepare = vi.hoisted(() => vi.fn())
vi.mock('@/lib/payments/orders/prepare-skattekonto', () => ({ prepareSkattekontoPaymentOrder: prepare }))

import { POST } from '../orders/skattekonto/route'

const ACCOUNT = '33333333-3333-4333-8333-333333333333'
const none = { params: Promise.resolve({}) }
const post = (body: unknown) => createMockRequest('/api/payments/orders/skattekonto', { method: 'POST', body })

type ErrorBody = { error: { code: string; message: string } }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe('POST /api/payments/orders/skattekonto', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await POST(post({ cash_account_id: ACCOUNT }), none)
    expect(response.status).toBe(401)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('answers 400 for a missing account, an amount of zero or less and a date that is no date', async () => {
    for (const body of [{}, { cash_account_id: 'acct-1' }, { cash_account_id: ACCOUNT, amount: 0 }, { cash_account_id: ACCOUNT, amount: -1 }, { cash_account_id: ACCOUNT, execution_date: '11/11/2026' }]) {
      const response = await POST(post(body), none)
      expect(response.status).toBe(400)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('creates the draft and answers 201 with it', async () => {
    const data = { order: { id: 'order-1', purpose: 'skattekonto' }, warnings: [], replaced_draft_ids: [] }
    prepare.mockResolvedValue({ ok: true, data })

    const { status, body } = await parseJsonResponse<{ data: typeof data }>(
      await POST(post({ cash_account_id: ACCOUNT, amount: 11000, execution_date: '2026-11-11' }), none),
    )

    expect(status).toBe(201)
    expect(body.data).toEqual(data)
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({ cashAccountId: ACCOUNT, amount: 11000, executionDate: '2026-11-11', dryRun: false, today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
    )
  })

  it('answers the preview of a dry run with 200, defaults left to the service', async () => {
    prepare.mockResolvedValue({ ok: true, dryRun: true, preview: { amount: 11000 } })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await POST(post({ cash_account_id: ACCOUNT, dry_run: true }), none))
    expect(status).toBe(200)
    expect(body.data).toEqual({ amount: 11000 })
    expect(prepare).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amount: null, executionDate: null, dryRun: true }))
  })

  it('answers a refusal in Swedish with its code', async () => {
    prepare.mockResolvedValue({ ok: false, code: 'SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT', details: { payment_order_id: 'signed-1' } })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ cash_account_id: ACCOUNT }), none))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT')
    expect(body.error.message).toBe('En betalning till Skatteverket väntar redan under Betalningar.')
  })
})
