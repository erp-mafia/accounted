import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

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

import { POST } from '../parse/route'
import type { CustomerImportParseResult } from '@/lib/import/customers/types'

type ParseBody = { data: CustomerImportParseResult }

const mockUser = { id: 'user-1', email: 'test@test.se' }

function xlsxFile(rows: (string | number)[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Kunder')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([out], 'kunder.xlsx')
}

function post(file?: File) {
  const formData = new FormData()
  if (file) formData.append('file', file)
  const request = new Request('http://localhost/api/import/customers/parse', {
    method: 'POST',
    body: formData,
  })
  return POST(request, { params: Promise.resolve({}) })
}

describe('POST /api/import/customers/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post(xlsxFile([['Namn'], ['Acme AB']])))
    expect(status).toBe(401)
  })

  it('returns 400 without a file', async () => {
    const { status } = await parseJsonResponse(await post())
    expect(status).toBe(400)
  })

  it('annotates customer number matches, and same-name rows only as possible duplicates', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'by-org', name: 'Acme AB', customer_number: null, org_number: '5560217780', email: null },
      { id: 'by-number', name: 'Beta Sverige', customer_number: '1002', org_number: null, email: null },
      { id: 'anna', name: 'Anna Svensson', customer_number: null, org_number: null, email: null },
    ])

    const res = await post(xlsxFile([
      ['Kundnummer', 'Namn', 'Orgnr', 'E-post'],
      ['1002', 'Beta AB', '5560217780', ''],
      ['', 'anna  svensson', '', ''],
      ['', 'Gamma AB', '', ''],
    ]))
    const { status, body } = await parseJsonResponse<ParseBody>(res)

    expect(status).toBe(200)
    const [beta, anna, gamma] = body.data.rows
    expect(beta.duplicate_match).toEqual({
      customer_id: 'by-number',
      matched_by: 'customer_number',
      existing_name: 'Beta Sverige',
    })
    expect(beta.possible_duplicate).toBeNull()
    expect(anna.duplicate_match).toBeNull()
    expect(anna.possible_duplicate).toEqual({ customer_id: 'anna', existing_name: 'Anna Svensson' })
    expect(gamma.duplicate_match).toBeNull()
    expect(gamma.possible_duplicate).toBeNull()
    // A possible duplicate is not counted as a match.
    expect(body.data.duplicate_count).toBe(1)
  })
})
