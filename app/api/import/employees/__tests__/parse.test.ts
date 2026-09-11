import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

const mockKommun = vi.fn()
vi.mock('@/lib/salary/tax-tables', () => ({
  fetchKommunTaxRates: (...a: unknown[]) => mockKommun(...a),
}))

import { POST } from '../parse/route'

const PNR_A = '190001010008'
const PNR_B = '190203040001'
const mockUser = { id: 'user-1', email: 'test@test.se' }
// withRouteContext handlers take (request, routeContext); this route has no params.
const routeCtx = { params: Promise.resolve({}) } as never

function xlsxFile(rows: (string | number)[][], name = 'anstallda.xlsx'): File {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Blad1')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([out], name)
}

function makeRequest(file: File | null, overrides?: unknown) {
  const fd = new FormData()
  if (file) fd.append('file', file)
  if (overrides) fd.append('column_overrides', JSON.stringify(overrides))
  return new Request('http://localhost:3000/api/import/employees/parse', { method: 'POST', body: fd })
}

const HEADERS = ['Förnamn', 'Efternamn', 'Personnummer', 'Anställningsdatum', 'Månadslön', 'Kommun']

describe('POST /api/import/employees/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
    mockKommun.mockResolvedValue([{ kommun: 'Stockholm', totalRate: 30.0, tableNumber: 30 }])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest(xlsxFile([HEADERS])), routeCtx)
    expect(res.status).toBe(401)
  })

  it('returns 400 when no file is attached', async () => {
    const res = await POST(makeRequest(null), routeCtx)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('REG_IMPORT_NO_FILE')
  })

  it('returns 400 for an unsupported extension', async () => {
    const res = await POST(makeRequest(xlsxFile([HEADERS], 'anstallda.pdf')), routeCtx)
    expect(res.status).toBe(400)
  })

  // Runs before the happy path on purpose: the route caches the kommun map
  // per year for the process lifetime, so a cached map would mask the failure.
  it('still parses when the kommun map is unavailable', async () => {
    mockKommun.mockRejectedValue(new Error('skv down'))
    const res = await POST(
      makeRequest(xlsxFile([HEADERS, ['Test', 'Personson', PNR_A, '2026-01-01', 30000, 'Stockholm']])),
      routeCtx,
    )
    const { status, body } = await parseJsonResponse<{ data: { rows: Array<{ is_valid: boolean; validation_errors: string[] }> } }>(res)
    expect(status).toBe(200)
    expect(body.data.rows[0].is_valid).toBe(false)
    expect(body.data.rows[0].validation_errors.join(' ')).toMatch(/Skattetabell/)
  })

  it('parses rows, resolves the tax table from the kommun and flags duplicates', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'emp-1', first_name: 'Redan', last_name: 'Anställd', personnummer: encryptPersonnummer(PNR_B), is_active: true },
    ])

    const res = await POST(
      makeRequest(
        xlsxFile([
          HEADERS,
          ['Test', 'Personson', PNR_A, '2026-01-01', 30000, 'Stockholm'],
          ['Redan', 'Anställd', PNR_B, '2025-01-01', 31000, 'Stockholm'],
        ]),
      ),
      routeCtx,
    )
    const { status, body } = await parseJsonResponse<{ data: {
      rows: Array<{ is_valid: boolean; validation_errors: string[]; employee: { tax_table_number?: number; personnummer: string }; duplicate_match: { employee_id: string } | null }>
      duplicate_count: number
    } }>(res)

    expect(status).toBe(200)
    expect(body.data.rows).toHaveLength(2)
    expect(body.data.rows[0].employee.tax_table_number).toBe(30)
    expect(body.data.rows[0].is_valid, body.data.rows[0].validation_errors.join('; ')).toBe(true)
    expect(body.data.rows[0].duplicate_match).toBeNull()
    expect(body.data.rows[1].duplicate_match?.employee_id).toBe('emp-1')
    expect(body.data.duplicate_count).toBe(1)
    // The roster ciphertext never reaches the client.
    expect(JSON.stringify(body)).not.toContain(encryptPersonnummer(PNR_B).slice(0, 20))
  })

})
