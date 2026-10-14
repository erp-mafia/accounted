import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/proposal-preview', () => ({
  previewProposalLines: vi.fn(),
}))

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { previewProposalLines } from '@/lib/bookkeeping/proposal-preview'
import { POST } from '../route'

const TX_ID = '6f1c2b8e-1d2a-4c3b-9e8f-7a6b5c4d3e2f'

function request(body: unknown) {
  return createMockRequest('/api/bookkeeping/proposal-preview', { method: 'POST', body })
}

const call = (body: unknown) => POST(request(body), { params: Promise.resolve({}) })

function signedIn() {
  const { supabase } = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/bookkeeping/proposal-preview', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    expect((await call({ amount: 100, template_id: 'saas' })).status).toBe(401)
    expect(previewProposalLines).not.toHaveBeenCalled()
  })

  it('returns 400 for a body that names neither a transaction nor a total', async () => {
    signedIn()

    expect((await call({ amount: 100 })).status).toBe(400)
    expect((await call({ transaction_id: 'not-a-uuid', booking: { is_business: true } })).status).toBe(400)
    expect((await call({ amount: -5, template_id: 'saas' })).status).toBe(400)
    expect(previewProposalLines).not.toHaveBeenCalled()
  })

  it('returns 404 when the transaction is not the company’s', async () => {
    signedIn()
    vi.mocked(previewProposalLines).mockResolvedValue({ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await call({ transaction_id: TX_ID, booking: { is_business: true, category: 'expense_office' } }),
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('answers the refusal the booking would give, with its details', async () => {
    signedIn()
    vi.mocked(previewProposalLines).mockResolvedValue({
      ok: false,
      code: 'TX_CATEGORIZE_INVALID_TEMPLATE',
      details: { templateId: 'ab_only', reason: 'not_for_entity' },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: unknown } }>(
      await call({ amount: 125, template_id: 'ab_only' }),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('TX_CATEGORIZE_INVALID_TEMPLATE')
  })

  it('answers the lines for the active company, the parsed proposal passed as sent', async () => {
    const supabase = signedIn()
    const lines = [
      { side: 'debet', account: '6540', amount: 100 },
      { side: 'debet', account: '2641', amount: 25 },
      { side: 'kredit', account: '1930', amount: 125, settlement: true },
    ]
    vi.mocked(previewProposalLines).mockResolvedValue({ ok: true, lines: lines as never })

    const booking = { is_business: true, category: 'expense_software', vat_treatment: 'standard_25' }
    const { status, body } = await parseJsonResponse<{ data: { lines: unknown[] } }>(
      await call({ transaction_id: TX_ID, booking }),
    )

    expect(status).toBe(200)
    expect(body.data.lines).toEqual(lines)
    expect(previewProposalLines).toHaveBeenCalledWith(
      expect.objectContaining({ supabase, companyId: 'company-1' }),
      { transaction_id: TX_ID, booking },
    )
  })

  it('takes an utlägg pair as money out with its reverse-charge supplier type', async () => {
    signedIn()
    vi.mocked(previewProposalLines).mockResolvedValue({ ok: true, lines: [] })

    const pair = { debit_account: '5420', credit_account: '2820', vat_treatment: 'reverse_charge', reverse_charge_supplier_type: 'non_eu_business' }
    expect((await call({ amount: 1000, pair })).status).toBe(200)
    expect(previewProposalLines).toHaveBeenCalledWith(expect.anything(), { amount: 1000, pair })
  })
})
