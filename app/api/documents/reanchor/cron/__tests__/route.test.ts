import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyCronSecret = vi.fn<() => unknown>(() => null)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: () => verifyCronSecret(),
}))

vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: vi.fn(() => ({ mocked: true })),
}))

const sweepFloatingSupplierInvoiceDocuments = vi.fn()
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  sweepFloatingSupplierInvoiceDocuments: (...args: unknown[]) =>
    sweepFloatingSupplierInvoiceDocuments(...args),
}))

import { GET } from '../route'

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/documents/reanchor/cron')
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecret.mockReturnValue(null)
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
})

describe('GET /api/documents/reanchor/cron', () => {
  it('rejects a request without a valid cron secret', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(sweepFloatingSupplierInvoiceDocuments).not.toHaveBeenCalled()
  })

  it('runs the sweep under the service-role client and reports the summary', async () => {
    sweepFloatingSupplierInvoiceDocuments.mockResolvedValue({ candidates: 3, anchored: 2 })

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json).toEqual({ data: { candidates: 3, anchored: 2 } })
    expect(sweepFloatingSupplierInvoiceDocuments).toHaveBeenCalledWith({ mocked: true })
  })

  it('fails closed when Supabase configuration is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const response = await GET(cronRequest())

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(sweepFloatingSupplierInvoiceDocuments).not.toHaveBeenCalled()
  })
})
