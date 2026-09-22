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

const SUPPLIER = {
  id: 's1',
  name: 'Leverantör AB',
  supplier_type: 'swedish_business',
  org_number: '5560217780',
  vat_number: 'SE556021778001',
  email: 'faktura@lev.se',
  phone: null,
  address_line1: null,
  address_line2: null,
  postal_code: null,
  city: 'Malmö',
  country: 'Sweden',
  bankgiro: '5050-1055',
  plusgiro: null,
  bank_account: null,
  iban: null,
  bic: null,
  default_payment_terms: 30,
  default_currency: 'SEK',
  notes: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockFetchAllRows.mockResolvedValue([SUPPLIER])
})

describe('GET /api/export/suppliers', () => {
  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/export/suppliers'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns an xlsx supplier register with banking columns', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })
    const res = await GET(createMockRequest('/api/export/suppliers'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('leverantorer-')

    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    const headers = (rows[0] as string[]).map(String)
    expect(headers).toContain('Bankgiro')
    expect(headers).toContain('Valuta')
    expect((rows[1] as string[])).toContain('Leverantör AB')
  })
})
