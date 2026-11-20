/**
 * crm#1084: the customer card shows each invoice with the invoice list's
 * status line (lib/invoices/status-display.ts invoiceRowStatus), so the
 * route reads every column that line needs. With status, total and the
 * dates only, a credit note, an unsent number, a paid date and an overdue
 * remainder were invisible to the card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createPagedMockSupabase, parseJsonResponse } from '@/tests/helpers'

let mock = createPagedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mock.supabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../[id]/route'

describe('GET /api/customers/[id]: the invoices carry the status line columns', () => {
  beforeEach(() => vi.clearAllMocks())

  it('selects what invoiceRowStatus reads', async () => {
    mock = createPagedMockSupabase({
      customers: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Kund AB', customer_type: 'swedish_business', personal_number: null }],
      invoices: [{ id: 'inv-1', status: 'sent', due_date: '2026-09-01', remaining_amount: 500 }],
    })
    mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } }, error: null })

    const res = await GET(createMockRequest('/api/customers/cccccccc-cccc-4ccc-8ccc-cccccccccccc'), { params: Promise.resolve({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }) })
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const columns = String(mock.findCalls('invoices', 'select')[0]?.[0])
      .split(',')
      .map((column) => column.trim())
    for (const column of [
      'status',
      'due_date',
      'remaining_amount',
      'paid_at',
      'document_type',
      'credited_invoice_id',
      'invoice_number',
      // A received self-billing invoice has no invoice_number: the card
      // shows the customer's number instead of "(Utkast)" (crm#1375).
      'external_invoice_number',
      'is_self_billed',
      'quote_status',
      'valid_until',
      // The amount the card prints is the invoice list's (getDisplayTotal):
      // the invoice's own öresavrundning choice decides it.
      'ore_rounding',
      'total',
      'currency',
    ]) {
      expect(columns, column).toContain(column)
    }
  })

  it('answers 404 for a customer that is not in the company', async () => {
    mock = createPagedMockSupabase({ customers: [] })
    mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } }, error: null })

    const res = await GET(createMockRequest('/api/customers/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), { params: Promise.resolve({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) })
    expect(res.status).toBe(404)
  })

  it('answers 401 without a session', async () => {
    mock = createPagedMockSupabase({ customers: [] })
    mock.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    const res = await GET(createMockRequest('/api/customers/cccccccc-cccc-4ccc-8ccc-cccccccccccc'), { params: Promise.resolve({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }) })
    expect(res.status).toBe(401)
  })
})
