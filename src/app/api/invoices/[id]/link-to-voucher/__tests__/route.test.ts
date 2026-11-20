import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockLink = vi.fn()
vi.mock('@/lib/invoices/voucher-matching', () => ({
  linkInvoiceToVoucher: (...args: unknown[]) => mockLink(...args),
}))

import { POST } from '../route'

const JE = '11111111-1111-4111-8111-111111111111'

function post(body: unknown) {
  return POST(
    createMockRequest('/api/invoices/inv-1/link-to-voucher', { method: 'POST', body }),
    createMockRouteParams({ id: 'inv-1' }),
  )
}

describe('POST /api/invoices/[id]/link-to-voucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await post({ journal_entry_id: JE }))

    expect(status).toBe(401)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('returns 400 without a journal_entry_id', async () => {
    const { status } = await parseJsonResponse(await post({}))

    expect(status).toBe(400)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('refuses a quote before the RPC: an offert carries no receivable', async () => {
    enqueue({ data: { document_type: 'quote' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ journal_entry_id: JE }),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('links a real invoice through the shared helper', async () => {
    enqueue({ data: { document_type: 'invoice' }, error: null })
    mockLink.mockResolvedValue({
      ok: true,
      result: { invoiceId: 'inv-1', journalEntryId: JE, paymentAmount: 1250, paymentDate: '2026-06-10', newStatus: 'paid' },
    })

    const { status } = await parseJsonResponse(await post({ journal_entry_id: JE }))

    expect(status).toBe(200)
    expect(mockLink).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      'company-1',
      expect.objectContaining({ invoiceId: 'inv-1', journalEntryId: JE }),
    )
  })

  // crm#1434: one verifikat that settles several invoices is linked with each
  // invoice's share.
  it('passes a stated share to the helper and answers with what the verifikat has left', async () => {
    enqueue({ data: { document_type: 'invoice' }, error: null })
    mockLink.mockResolvedValue({
      ok: true,
      result: {
        paymentId: 'pay-1',
        invoiceStatus: 'paid',
        paidAmount: 1500,
        remainingAmount: 0,
        paymentAmount: 1500,
        journalEntryId: JE,
        reconciledTransactionId: null,
        saleJournalEntryId: null,
        voucherRemaining: 4573,
      },
    })

    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(
      await post({ journal_entry_id: JE, amount: 1500 }),
    )

    expect(status).toBe(200)
    expect(mockLink).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      'company-1',
      expect.objectContaining({ invoiceId: 'inv-1', journalEntryId: JE, amount: 1500 }),
    )
    expect(body.data).toMatchObject({ payment_amount: 1500, voucher_remaining: 4573 })
  })

  it('returns 400 for a share that is not a positive number', async () => {
    for (const amount of [0, -5, '1500']) {
      const { status } = await parseJsonResponse(await post({ journal_entry_id: JE, amount }))
      expect(status, String(amount)).toBe(400)
    }
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('maps a refusal of the share to its registered status', async () => {
    enqueue({ data: { document_type: 'invoice' }, error: null })
    mockLink.mockResolvedValue({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 1000, ar_credit: 6073, already_linked: 5073 },
    })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post({ journal_entry_id: JE, amount: 1500 }),
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER')
  })
})
