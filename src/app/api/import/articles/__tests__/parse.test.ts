import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import { streamedXlsx } from '@/tests/fixtures/streamed-xlsx'

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
import type { ArticleImportParseResult } from '@/lib/import/articles/types'

type ParseBody = { data: ArticleImportParseResult }

const mockUser = { id: 'user-1', email: 'test@test.se' }

function xlsxFile(rows: (string | number)[][], name = 'artiklar.xlsx'): File {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Artiklar')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([out], name)
}

function post(file?: File, columnOverrides?: string) {
  const formData = new FormData()
  if (file) formData.append('file', file)
  if (columnOverrides !== undefined) formData.append('column_overrides', columnOverrides)
  const request = new Request('http://localhost/api/import/articles/parse', {
    method: 'POST',
    body: formData,
  })
  return POST(request, { params: Promise.resolve({}) })
}

const SHEET: (string | number)[][] = [
  ['Artikelnummer', 'Benämning', 'Pris'],
  ['A-1', 'Konsulttimme', 1200],
  ['', 'Resetid', 600],
  ['', 'Ny tjänst', 900],
]

describe('POST /api/import/articles/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post(xlsxFile(SHEET)))
    expect(status).toBe(401)
  })

  it('returns 400 without a file', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(400)
    expect(body.error.code).toBe('REG_IMPORT_NO_FILE')
  })

  it('refuses a workbook the reader cannot open with what to do, not a 500', async () => {
    const cut = new Uint8Array(streamedXlsx({ rows: [['Benämning'], ['Acme AB']] })).slice(0, 600)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string } }>(
      await post(new File([cut], 'artiklar.xlsx')),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('IMPORT_WORKBOOK_UNREADABLE')
    expect(body.error.message).toContain('spara den utan lösenord som Excel-arbetsbok (.xlsx) eller som CSV')
    expect(body.error.message_en).toContain('save it without a password as an Excel workbook (.xlsx) or as CSV')
  })

  it('refuses a file type the register import does not read', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post(new File(['x'], 'artiklar.pdf')),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('REG_IMPORT_INVALID_FORMAT')
  })

  it('refuses column overrides that are not JSON', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post(xlsxFile(SHEET), '{not json'),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('REG_IMPORT_INVALID_COLUMN_OVERRIDES')
  })

  it('refuses column overrides the article schema rejects', async () => {
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await post(xlsxFile(SHEET), JSON.stringify({ name_col: -1 })),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('REG_IMPORT_INVALID_COLUMN_OVERRIDES')
    expect(mockFetchAllRows).not.toHaveBeenCalled()
  })

  it('annotates article-number matches first, then name matches', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'by-number', name: 'Timme', article_number: 'A-1' },
      { id: 'by-name', name: 'resetid', article_number: null },
    ])

    const { status, body } = await parseJsonResponse<ParseBody>(await post(xlsxFile(SHEET)))

    expect(status).toBe(200)
    expect(body.data.total_rows).toBe(3)
    expect(body.data.duplicate_count).toBe(2)
    expect(body.data.rows.map((r) => r.duplicate_match)).toEqual([
      { article_id: 'by-number', matched_by: 'article_number', existing_name: 'Timme' },
      { article_id: 'by-name', matched_by: 'name', existing_name: 'resetid' },
      null,
    ])
    expect(body.data.filename).toBe('artiklar.xlsx')
  })
})
