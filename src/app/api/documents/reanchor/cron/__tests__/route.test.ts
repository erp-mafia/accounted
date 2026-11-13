import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyCronSecret = vi.fn<() => unknown>(() => null)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: () => verifyCronSecret(),
}))

// The client the route hands the sweep: a stand-in unless a test sets a table mock.
const db = vi.hoisted(() => ({ client: { mocked: true } as unknown }))
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: vi.fn(() => db.client),
}))

const sweepFloatingSupplierInvoiceDocuments = vi.fn()
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  sweepFloatingSupplierInvoiceDocuments: (...args: unknown[]) =>
    sweepFloatingSupplierInvoiceDocuments(...args),
}))

import { GET } from '../route'
import { createCronRequest, createTableMockSupabase } from '@/tests/helpers'

beforeEach(() => {
  vi.clearAllMocks()
  db.client = { mocked: true }
  verifyCronSecret.mockReturnValue(null)
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
})

describe('GET /api/documents/reanchor/cron', () => {
  it('rejects a request without a valid cron secret', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })

    const response = await GET(createCronRequest('/api/documents/reanchor/cron'))

    expect(response.status).toBe(401)
    expect(sweepFloatingSupplierInvoiceDocuments).not.toHaveBeenCalled()
  })

  it('runs the sweep under the service-role client and reports the summary', async () => {
    sweepFloatingSupplierInvoiceDocuments.mockResolvedValue({ candidates: 3, anchored: 2 })

    const response = await GET(createCronRequest('/api/documents/reanchor/cron'))
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json).toEqual({ data: { candidates: 3, anchored: 2 } })
    expect(sweepFloatingSupplierInvoiceDocuments).toHaveBeenCalledWith({ mocked: true })
  })

  it('answers 5xx when the candidate scan fails: the real sweep, a failing read', async () => {
    // Before: the sweep answered zero candidates and the route 200, a broken
    // scan looked like a clean night.
    const actual = await vi.importActual<typeof import('@/lib/core/documents/supplier-invoice-underlag')>(
      '@/lib/core/documents/supplier-invoice-underlag',
    )
    sweepFloatingSupplierInvoiceDocuments.mockImplementation(actual.sweepFloatingSupplierInvoiceDocuments)
    const { supabase, findCalls } = createTableMockSupabase({ supplier_invoices: { error: { message: 'relation walk failed' } } })
    db.client = supabase

    const response = await GET(createCronRequest('/api/documents/reanchor/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(findCalls('supplier_invoices', 'limit')).toEqual([[200]])
  })

  it('fails closed when Supabase configuration is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const response = await GET(createCronRequest('/api/documents/reanchor/cron'))

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(sweepFloatingSupplierInvoiceDocuments).not.toHaveBeenCalled()
  })
})
