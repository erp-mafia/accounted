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

import { POST } from '../route'

type ErrorBody = { error: { code: string; message: string; message_en: string } }

const mockUser = { id: 'user-1', email: 'test@test.se' }

const BALANCE: (string | number)[][] = [
  ['Kontonr', 'Kontonamn', 'Debet', 'Kredit'],
  ['1930', 'Företagskonto', 50000, 0],
  ['2099', 'Årets resultat', 0, 50000],
]

function xlsxFile(rows: (string | number)[][], name = 'balans.xlsx'): File {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Balans')
  return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], name)
}

function post(file?: File, columnOverrides?: string) {
  const formData = new FormData()
  if (file) formData.append('file', file)
  if (columnOverrides !== undefined) formData.append('column_overrides', columnOverrides)
  const request = new Request('http://localhost/api/import/opening-balance/parse', {
    method: 'POST',
    body: formData,
  })
  return POST(request, { params: Promise.resolve({}) })
}

describe('POST /api/import/opening-balance/parse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const { status } = await parseJsonResponse(await post(xlsxFile(BALANCE)))
    expect(status).toBe(401)
  })

  it('returns 400 without a file', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await post())
    expect(status).toBe(400)
    expect(body.error.code).toBe('OB_NO_FILE')
  })

  it('returns 400 for a file type it does not read', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await post(xlsxFile(BALANCE, 'balans.pdf')))
    expect(status).toBe(400)
    expect(body.error.code).toBe('OB_INVALID_FORMAT')
  })

  it('returns 400 for a column mapping that is not JSON', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await post(xlsxFile(BALANCE), '{not json'))
    expect(status).toBe(400)
    expect(body.error.code).toBe('OB_INVALID_COLUMN_OVERRIDES')
  })

  it('answers the rows of a readable balance', async () => {
    const { status, body } = await parseJsonResponse<{
      data: { filename: string; sheet_name: string; rows: unknown[]; total_debit: number; total_credit: number }
    }>(await post(xlsxFile(BALANCE)))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ filename: 'balans.xlsx', sheet_name: 'Balans', total_debit: 50000, total_credit: 50000 })
    expect(body.data.rows).toHaveLength(2)
  })

  it('reads a workbook from a streaming zip writer', async () => {
    const { status, body } = await parseJsonResponse<{ data: { rows: unknown[] } }>(
      await post(new File([streamedXlsx({ rows: BALANCE })], 'balans.xlsx')),
    )
    expect(status).toBe(200)
    expect(body.data.rows).toHaveLength(2)
  })

  it('refuses a workbook the reader cannot open with what to do, not a 500', async () => {
    const cut = new Uint8Array(streamedXlsx({ rows: BALANCE })).slice(0, 600)
    const { status, body } = await parseJsonResponse<ErrorBody>(await post(new File([cut], 'balans.xlsx')))
    expect(status).toBe(400)
    expect(body.error.code).toBe('IMPORT_WORKBOOK_UNREADABLE')
    expect(body.error.message).toContain('spara den utan lösenord som Excel-arbetsbok (.xlsx) eller som CSV')
    expect(body.error.message_en).toContain('save it without a password as an Excel workbook (.xlsx) or as CSV')
  })
})
