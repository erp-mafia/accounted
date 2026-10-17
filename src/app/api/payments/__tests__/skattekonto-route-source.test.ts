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

describe('POST /api/payments/orders/skattekonto with a declaration', () => {
  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await POST(post({ cash_account_id: ACCOUNT, source: 'agi', year: 2026, month: 10 }), none)
    expect(response.status).toBe(401)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('answers 400 for a declaration without its period, and a period without a source', async () => {
    for (const body of [
      { cash_account_id: ACCOUNT, source: 'vat_declaration', year: 2026, period: 3 },
      { cash_account_id: ACCOUNT, source: 'vat_declaration', period_type: 'quarterly', year: 2026, period: 6 },
      { cash_account_id: ACCOUNT, source: 'agi', year: 2026 },
      { cash_account_id: ACCOUNT, year: 2026, month: 10 },
      { cash_account_id: ACCOUNT, source: 'moms' },
    ]) {
      const response = await POST(post(body), none)
      expect(response.status).toBe(400)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('hands the momsdeklaration to the service as the source', async () => {
    prepare.mockResolvedValue({ ok: true, dryRun: true, preview: { amount: 77404 } })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await POST(post({ cash_account_id: ACCOUNT, source: 'vat_declaration', period_type: 'quarterly', year: 2026, period: 3, dry_run: true }), none),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ amount: 77404 })
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      expect.objectContaining({
        cashAccountId: ACCOUNT,
        amount: null,
        dryRun: true,
        source: { kind: 'vat_declaration', periodType: 'quarterly', year: 2026, period: 3, fiscalPeriodId: null },
      }),
    )
  })

  it('creates the draft from an AGI and answers 201; no source is the next charge', async () => {
    const data = { order: { id: 'order-1', purpose: 'skattekonto' }, warnings: [], replaced_draft_ids: [], source: null, balance: null }
    prepare.mockResolvedValue({ ok: true, data })
    const created = await POST(post({ cash_account_id: ACCOUNT, source: 'agi', year: 2026, month: 10 }), none)
    expect(created.status).toBe(201)
    expect(prepare).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ source: { kind: 'agi', year: 2026, month: 10 } }))

    await POST(post({ cash_account_id: ACCOUNT }), none)
    expect(prepare).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ source: null }))
  })

  it('answers 404 in Swedish for a month without an AGI', async () => {
    prepare.mockResolvedValue({ ok: false, code: 'SKATTEKONTO_PAYMENT_AGI_NOT_FOUND', details: { tax_period: '2026-10' } })
    const { status, body } = await parseJsonResponse<ErrorBody>(await POST(post({ cash_account_id: ACCOUNT, source: 'agi', year: 2026, month: 10 }), none))
    expect(status).toBe(404)
    expect(body.error.code).toBe('SKATTEKONTO_PAYMENT_AGI_NOT_FOUND')
    expect(body.error.message).toBe('Det finns ingen arbetsgivardeklaration för månaden. Skapa den under Lön först.')
  })
})
