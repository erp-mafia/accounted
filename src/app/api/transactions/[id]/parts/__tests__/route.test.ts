import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

import { GET } from '../route'
import type { TransactionPartsResponse } from '@/lib/transactions/parts-read'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'

type Body = { data: TransactionPartsResponse }

const req = () => new Request('http://localhost/api/transactions/tx-1/parts')

const storedPart = (seq: number, amount: number, extra: Record<string, unknown> = {}) => ({
  id: `part-${seq}`, company_id: 'company-1', transaction_id: 'tx-1', seq, amount: String(amount), currency: 'SEK',
  counterparty_name: 'Kund AB', counterparty_org_number: '5560160680', counterparty_account: '5050-1055', reference: '10017',
  invoice_numbers: [], message: null, provider_part_id: `P${seq}`, suggested_invoice_id: null, suggested_supplier_invoice_id: null,
  suggestion_reason: null, created_at: '2026-10-12T05:00:00Z', updated_at: '2026-10-12T05:00:00Z', ...extra,
})

describe('GET /api/transactions/[id]/parts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.se' } as never,
      supabase: mockSupabase as never,
      error: null,
    })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(401)
  })

  it("returns 404 when the transaction is not the company's", async () => {
    enqueue({ data: null }) // transaction
    const { status } = await parseJsonResponse(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(404)
    expect(findCalls('transactions', 'eq')).toEqual([['company_id', 'company-1'], ['id', 'tx-1']])
  })

  it('returns no parts and no suggestion for a row without a split', async () => {
    enqueue({ data: { id: 'tx-1', potential_match_method: null } })
    enqueue({ data: [] }) // parts
    const { status, body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(status).toBe(200)
    expect(body.data).toEqual({ parts: [], batch_suggestion: null })
  })

  it('returns the parts in the bank\'s order with their suggested invoices, and the prefilled batch for a complete split', async () => {
    enqueue({ data: { id: 'tx-1', potential_match_method: 'bankgiro_split' } })
    enqueue({ data: [
      storedPart(1, 500, { suggested_invoice_id: 'inv-1001', suggestion_reason: 'ocr_exact' }),
      storedPart(2, 1000, { reference: null, invoice_numbers: ['1002'], suggested_invoice_id: 'inv-1002', suggestion_reason: 'invoice_number' }),
    ] })
    enqueue({ data: [
      { id: 'inv-1001', invoice_number: '1001', remaining_amount: '500.00', currency: 'SEK', status: 'sent', customer: { name: 'Kund AB' } },
      { id: 'inv-1002', invoice_number: '1002', remaining_amount: '1000.00', currency: 'SEK', status: 'overdue', customer: { name: 'Bolaget AB' } },
    ] })

    const { status, body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))

    expect(status).toBe(200)
    expect(body.data.parts).toEqual([
      {
        part_id: 'part-1', seq: 1, amount: 500, currency: 'SEK', counterparty_name: 'Kund AB', counterparty_org_number: '5560160680',
        counterparty_account: '5050-1055', reference: '10017', invoice_numbers: [], message: null, suggestion_reason: 'ocr_exact',
        suggested_invoice: { kind: 'customer_invoice', invoice_id: 'inv-1001', invoice_number: '1001', counterparty_name: 'Kund AB', remaining_amount: 500, currency: 'SEK' },
      },
      expect.objectContaining({
        seq: 2, amount: 1000, invoice_numbers: ['1002'], suggestion_reason: 'invoice_number',
        suggested_invoice: expect.objectContaining({ invoice_id: 'inv-1002', invoice_number: '1002', counterparty_name: 'Bolaget AB', remaining_amount: 1000 }),
      }),
    ])
    expect(body.data.batch_suggestion).toEqual({
      allocations: [
        { kind: 'customer_invoice', invoice_id: 'inv-1001', amount: 500 },
        { kind: 'customer_invoice', invoice_id: 'inv-1002', amount: 1000 },
      ],
    })
    // The suggested invoices are read for this company only.
    expect(findCalls('invoices', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('invoices', 'in')).toEqual([['id', ['inv-1001', 'inv-1002']]])
  })

  it('drops a suggestion whose invoice is no longer open and then offers no batch, and reads supplier invoices for a payout', async () => {
    enqueue({ data: { id: 'tx-1', potential_match_method: 'bankgiro_split' } })
    enqueue({ data: [
      storedPart(1, -1200, { suggested_supplier_invoice_id: 'si-1', suggestion_reason: 'ocr_exact' }),
      storedPart(2, -300, { suggested_supplier_invoice_id: 'si-2', suggestion_reason: 'invoice_number' }),
    ] })
    enqueue({ data: [
      { id: 'si-1', supplier_invoice_number: 'INV-77', arrival_number: 7, remaining_amount: 1200, currency: 'SEK', status: 'approved', supplier: { name: 'Tele2' } },
      { id: 'si-2', supplier_invoice_number: null, arrival_number: 8, remaining_amount: 0, currency: 'SEK', status: 'paid', supplier: { name: 'Tele2' } },
    ] })

    const { status, body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))

    expect(status).toBe(200)
    expect(body.data.parts[0]!.suggested_invoice).toEqual({ kind: 'supplier_invoice', invoice_id: 'si-1', invoice_number: 'INV-77', counterparty_name: 'Tele2', remaining_amount: 1200, currency: 'SEK' })
    expect(body.data.parts[1]!.suggested_invoice).toBeNull()
    expect(body.data.parts[1]!.suggestion_reason).toBeNull()
    expect(body.data.batch_suggestion).toBeNull()
    expect(findCalls('supplier_invoices', 'in')).toEqual([['id', ['si-1', 'si-2']]])
    expect(findCalls('invoices', 'in')).toHaveLength(0)
  })

  it('offers no batch for parts without the split marker even when every part has a suggestion', async () => {
    enqueue({ data: { id: 'tx-1', potential_match_method: null } })
    enqueue({ data: [storedPart(1, 500, { suggested_invoice_id: 'inv-1001', suggestion_reason: 'ocr_exact' })] })
    enqueue({ data: [{ id: 'inv-1001', invoice_number: '1001', remaining_amount: 500, currency: 'SEK', status: 'sent', customer: { name: 'Kund AB' } }] })
    const { body } = await parseJsonResponse<Body>(await GET(req(), createMockRouteParams({ id: 'tx-1' })))
    expect(body.data.parts).toHaveLength(1)
    expect(body.data.batch_suggestion).toBeNull()
  })
})
