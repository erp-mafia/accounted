/**
 * The supplier roster, the supplier-invoice list and a supplier's totals read
 * every row, not PostgREST's first 1,000 (max-rows): past that the list ended
 * early and the totals undercounted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createPagedMockSupabase,
  manyRows,
  parseJsonResponse,
} from '@/tests/helpers'

// Route path ids are uuids: the route answers its 404 to anything else before it reads.
const S_1 = 'ef740adb-d54a-5738-9f2f-ad3dafa845ac'

let mock = createPagedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mock.supabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET as listSuppliers } from '../route'
import { GET as getSupplier } from '../[id]/route'
import { GET as listSupplierInvoices } from '@/app/api/supplier-invoices/route'

function withTables(tables: Parameters<typeof createPagedMockSupabase>[0]) {
  mock = createPagedMockSupabase(tables)
  mock.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } }, error: null })
}

describe('supplier lists past 1,000 rows', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET /api/suppliers returns every supplier, ordered by name then id', async () => {
    withTables({ suppliers: manyRows(1001, (i) => ({ id: `s-${i}`, name: `Leverantör ${i}` })) })

    const res = await listSuppliers(createMockRequest('/api/suppliers'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(res)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1001)
    expect(mock.findCalls('suppliers', 'order').map((a) => a[0]).slice(0, 2)).toEqual(['name', 'id'])
  })

  it('GET /api/supplier-invoices returns every invoice, ordered by due date then id', async () => {
    withTables({ supplier_invoices: manyRows(1001, (i) => ({ id: `si-${i}`, due_date: '2026-10-01' })) })

    const res = await listSupplierInvoices(createMockRequest('/api/supplier-invoices'), { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(res)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1001)
    expect(mock.findCalls('supplier_invoices', 'order').map((a) => a[0]).slice(0, 2)).toEqual(['due_date', 'id'])
  })

  it("GET /api/suppliers/[id] counts and sums every one of the supplier's invoices", async () => {
    withTables({
      suppliers: [{ id: S_1, name: 'Alfa AB' }],
      supplier_invoices: manyRows(1001, () => ({ status: 'approved', total: 100, remaining_amount: 100, paid_amount: 0, currency: 'SEK' })),
    })

    const res = await getSupplier(createMockRequest(`/api/suppliers/${S_1}`), { params: Promise.resolve({ id: S_1 }) })
    const { status, body } = await parseJsonResponse<{ data: { stats: { invoice_count: number; by_currency: Array<{ total_outstanding: number }> } } }>(res)

    expect(status).toBe(200)
    expect(body.data.stats.invoice_count).toBe(1001)
    expect(body.data.stats.by_currency[0].total_outstanding).toBe(100100)
  })
})
