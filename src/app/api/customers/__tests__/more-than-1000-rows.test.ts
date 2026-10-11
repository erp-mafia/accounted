/**
 * A customer's invoice list reads every invoice, not PostgREST's first 1,000
 * (max-rows): past that the customer page lost its oldest invoices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createPagedMockSupabase,
  manyRows,
  parseJsonResponse,
} from '@/tests/helpers'

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

describe('GET /api/customers/[id] past 1,000 invoices', () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns every one of the customer's invoices, newest first with id as tiebreaker", async () => {
    mock = createPagedMockSupabase({
      customers: [{ id: 'c-1', name: 'Kund AB', customer_type: 'swedish_business', personal_number: null }],
      invoices: manyRows(1001, (i) => ({ id: `inv-${i}`, invoice_date: '2026-10-01' })),
    })
    mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } }, error: null })

    const res = await GET(createMockRequest('/api/customers/c-1'), { params: Promise.resolve({ id: 'c-1' }) })
    const { status, body } = await parseJsonResponse<{ data: { invoices: unknown[] } }>(res)

    expect(status).toBe(200)
    expect(body.data.invoices).toHaveLength(1001)
    expect(mock.findCalls('invoices', 'order').map((a) => a[0]).slice(0, 2)).toEqual(['invoice_date', 'id'])
  })
})
