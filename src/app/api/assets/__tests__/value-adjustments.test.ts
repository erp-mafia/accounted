import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { AssetValueAdjustmentBlockedError } from '@/lib/bookkeeping/errors'

const { supabase, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/bokslut/assets/value-adjustment-service', () => ({
  previewValueAdjustment: vi.fn(),
  postValueAdjustment: vi.fn(),
}))

import { postValueAdjustment, previewValueAdjustment } from '@/lib/bokslut/assets/value-adjustment-service'
import { POST } from '../[id]/value-adjustments/route'

const params = { params: Promise.resolve({ id: 'asset-1' }) }
const PERIOD = '11111111-1111-4111-8111-111111111111'
const body = {
  kind: 'impairment',
  fiscal_period_id: PERIOD,
  recoverable_amount: 600_000,
  reason: 'Marknadsvärdet har fallit (K3 27.4).',
}

const preview = {
  asset: { id: 'asset-1', name: 'Kontorshus' },
  fiscalPeriod: { id: PERIOD, period_start: '2026-01-01', period_end: '2026-12-31' },
  kind: 'impairment',
  adjustmentDate: '2026-12-31',
  recoverableAmount: 600_000,
  carryingAmountBefore: 780_000,
  amount: 180_000,
  carryingAmountAfter: 600_000,
  expenseAccount: '7720',
  accumulatedAccount: '1118',
  lines: [
    { account_number: '7720', debit_amount: 180_000, credit_amount: 0, line_description: 'Nedskrivning: Kontorshus' },
    { account_number: '1118', debit_amount: 0, credit_amount: 180_000, line_description: 'Ackumulerad nedskrivning: Kontorshus' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

function request(payload: unknown) {
  return createMockRequest('/api/assets/asset-1/value-adjustments', { method: 'POST', body: payload })
}

describe('POST /api/assets/[id]/value-adjustments', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(request(body), params)
    expect(res.status).toBe(401)
    expect(postValueAdjustment).not.toHaveBeenCalled()
  })

  it('returns 400 without a reason or with an unknown kind', async () => {
    expect((await POST(request({ ...body, reason: '  ' }), params)).status).toBe(400)
    expect((await POST(request({ ...body, kind: 'revaluation' }), params)).status).toBe(400)
    expect(postValueAdjustment).not.toHaveBeenCalled()
  })

  it('returns 404 when the asset is not in the company', async () => {
    vi.mocked(postValueAdjustment).mockRejectedValue(
      Object.assign(new Error('ASSET_NOT_FOUND'), { code: 'ASSET_NOT_FOUND' }),
    )
    expect((await POST(request(body), params)).status).toBe(404)
  })

  it('answers the plan on dry_run and posts nothing', async () => {
    vi.mocked(previewValueAdjustment).mockResolvedValue(preview as never)
    const { status, body: json } = await parseJsonResponse<{ data: { amount: number; lines: unknown[] } }>(
      await POST(request({ ...body, dry_run: true }), params),
    )
    expect(status).toBe(200)
    expect(json.data.amount).toBe(180_000)
    expect(json.data.lines).toHaveLength(2)
    expect(previewValueAdjustment).toHaveBeenCalledWith(supabase, 'company-1', 'asset-1', body)
    expect(postValueAdjustment).not.toHaveBeenCalled()
  })

  it('posts the write-down for the signed-in user', async () => {
    vi.mocked(postValueAdjustment).mockResolvedValue({
      asset: { id: 'asset-1' },
      entry: { id: 'entry-1' },
      preview,
    } as never)
    const { status, body: json } = await parseJsonResponse<{ data: { journal_entry_id: string; amount: number } }>(
      await POST(request(body), params),
    )
    expect(status).toBe(200)
    expect(json.data).toMatchObject({ journal_entry_id: 'entry-1', amount: 180_000 })
    expect(postValueAdjustment).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'asset-1', body)
  })

  it('maps a refusal to 409 with its Swedish reason', async () => {
    vi.mocked(postValueAdjustment).mockRejectedValue(new AssetValueAdjustmentBlockedError('year_not_depreciated'))
    const { status, body: json } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await POST(request(body), params),
    )
    expect(status).toBe(409)
    expect(json.error.code).toBe('ASSET_VALUE_ADJUSTMENT_BLOCKED')
    expect(json.error.message).toContain('årets avskrivning')
  })
})
