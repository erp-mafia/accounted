import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const CUSTOMER = {
  id: 'c1',
  name: 'Acme AB',
  customer_type: 'swedish_business',
  org_number: '5560217780',
  personal_number: null,
  email: 'kontakt@acme.se',
  phone: '0701234567',
  address_line1: 'Storgatan 1',
  address_line2: null,
  postal_code: '11122',
  city: 'Göteborg',
  country: 'Sweden',
  vat_number: 'SE556021778001',
  default_payment_terms: 30,
  notes: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockFetchAllRows.mockResolvedValue([CUSTOMER])
})

describe('GET /api/export/customers', () => {
  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/export/customers'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns an xlsx customer register', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/customers'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml')
    expect(res.headers.get('Content-Disposition')).toContain('kunder-')

    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    expect((rows[0] as string[])[0]).toBe('Namn')
    expect((rows[1] as string[])).toContain('Acme AB')
  })

  it('returns a CSV with BOM when format=csv', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/customers', { searchParams: { format: 'csv' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    const buf = Buffer.from(await res.arrayBuffer())
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.toString('utf-8')).toContain('Göteborg')
  })
})
