import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { detectArticleColumns } from '@/lib/import/articles/column-detector'

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

const ARTICLE = {
  id: 'a1',
  article_number: '100',
  name: 'Webdesign',
  name_en: 'Web design',
  type: 'tjanst',
  unit: 'st',
  price_excl_vat: 1200,
  vat_rate: 25,
  revenue_account: '3001',
  cost_price: 400,
  ean: '7350000000001',
  housework_type: null,
  notes: 'Kommentar med åäö',
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockFetchAllRows.mockResolvedValue([ARTICLE])
})

describe('GET /api/export/articles', () => {
  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(createMockRequest('/api/export/articles'))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns an xlsx workbook whose headers round-trip through the importer', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })

    const res = await GET(createMockRequest('/api/export/articles'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('spreadsheetml')
    const disposition = res.headers.get('Content-Disposition') || ''
    expect(disposition).toContain('attachment')
    expect(disposition).toContain('artiklar-acme-ab')
    expect(disposition).toContain('.xlsx')

    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.length).toBeGreaterThan(0)

    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    const headers = (rows[0] as string[]).map(String)
    // Round-trip: the exported headers must re-detect with high confidence.
    const detected = detectArticleColumns(headers)
    expect(detected.confidence).toBeGreaterThanOrEqual(0.8)
    expect(detected.name_col).toBeGreaterThanOrEqual(0)
    expect(detected.price_col).not.toBeNull()
    expect(detected.vat_rate_col).not.toBeNull()
    expect(detected.revenue_account_col).not.toBeNull()
  })

  it('returns a UTF-8 BOM CSV when format=csv', async () => {
    enqueue({ data: { company_name: 'Acme AB' } })

    const res = await GET(createMockRequest('/api/export/articles', { searchParams: { format: 'csv' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/csv')
    expect(res.headers.get('Content-Disposition')).toContain('.csv')

    const buf = Buffer.from(await res.arrayBuffer())
    // UTF-8 BOM
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.toString('utf-8')).toContain('Webdesign')
  })
})
