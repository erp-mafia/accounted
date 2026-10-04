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
import type { SupplierImportParseResult } from '@/lib/import/suppliers/types'

type ParseBody = { data: SupplierImportParseResult }

const mockUser = { id: 'user-1', email: 'test@test.se' }

function xlsxFile(rows: (string | number)[][]): File {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Leverantörer')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([out], 'leverantorer.xlsx')
}

function post(file?: File) {
  const formData = new FormData()
  if (file) formData.append('file', file)
  const request = new Request('http://localhost/api/import/suppliers/parse', {
    method: 'POST',
    body: formData,
  })
  return POST(request, { params: Promise.resolve({}) })
}

describe('POST /api/import/suppliers/parse', () => {
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

  it('annotates org number matches, and same-name rows only as possible duplicates', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'by-org', name: 'Acme AB', org_number: '5560217780', email: null },
      { id: 'kontor', name: 'Kontorsvaror AB', org_number: null, email: null },
    ])

    const res = await post(xlsxFile([
      ['Namn', 'Orgnr'],
      ['Acme Sverige AB', '165560217780'],
      ['KONTORSVAROR AB', ''],
    ]))
    const { status, body } = await parseJsonResponse<ParseBody>(res)

    expect(status).toBe(200)
    const [acme, kontor] = body.data.rows
    expect(acme.duplicate_match).toEqual({
      supplier_id: 'by-org',
      matched_by: 'org_number',
      existing_name: 'Acme AB',
    })
    expect(kontor.duplicate_match).toBeNull()
    expect(kontor.possible_duplicate).toEqual({ supplier_id: 'kontor', existing_name: 'Kontorsvaror AB' })
    expect(body.data.duplicate_count).toBe(1)
  })
})
