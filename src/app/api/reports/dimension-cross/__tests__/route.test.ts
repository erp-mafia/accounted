import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { DimensionCrossLinesPage, DimensionCrossReport } from '@/types'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The exports hold the SIE read lease; its own tests cover that boundary.
const leaseMock = vi.fn()
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, op: unknown, read: () => Promise<unknown>) => {
    leaseMock(op)
    return read()
  },
}))

vi.mock('@/lib/reports/dimension-cross', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reports/dimension-cross')>()),
  generateDimensionCross: vi.fn(),
  fetchDimensionCrossLines: vi.fn(),
}))

vi.mock('@react-pdf/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-pdf/renderer')>()),
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
}))

import { DimensionCrossNotReadyError, fetchDimensionCrossLines, generateDimensionCross } from '@/lib/reports/dimension-cross'
import { GET } from '../route'
import { GET as GET_LINES } from '../lines/route'
import { GET as GET_XLSX } from '../xlsx/route'
import { GET as GET_PDF } from '../pdf/route'

const mockGenerate = vi.mocked(generateDimensionCross)
const mockLines = vi.mocked(fetchDimensionCrossLines)

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const noParams = { params: Promise.resolve({}) }
const AXES = { period_id: 'period-1', dim_a: '1', dim_b: '6' }

const REPORT: DimensionCrossReport = {
  dim_a: { sie_dim_no: '1', name: 'Region' },
  dim_b: { sie_dim_no: '6', name: 'Kanal' },
  accounts: { from: '3000', to: '8999' },
  rows: [{ code: 'NORR', name: 'Region Norr' }, { code: null, name: null }],
  columns: [{ code: 'WEB', name: 'Webb' }, { code: null, name: null }],
  cells: [[1000, 250], [0, -60]],
  row_totals: [1250, -60],
  column_totals: [1000, 190],
  total: 1190,
  period: { start: '2026-01-01', end: '2026-12-31' },
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
})

describe('GET /api/reports/dimension-cross', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET(createMockRequest('/api/reports/dimension-cross', { searchParams: AXES }), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 without a period, with one dimension twice or a half range', async () => {
    const bad: Array<Record<string, string>> = [
      { dim_a: '1', dim_b: '6' },
      { ...AXES, dim_b: '1' },
      { ...AXES, dim_a: '1,is.null' },
      { ...AXES, account_from: '3000' },
      { ...AXES, account_from: '2000', account_to: '2999' },
    ]
    for (const searchParams of bad) {
      const res = await GET(createMockRequest('/api/reports/dimension-cross', { searchParams }), noParams)
      expect(res.status, JSON.stringify(searchParams)).toBe(400)
    }
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 404 when the period is not the company\'s', async () => {
    enqueue({ data: null }) // fiscal_periods
    const res = await GET(createMockRequest('/api/reports/dimension-cross', { searchParams: AXES }), noParams)
    expect(res.status).toBe(404)
  })

  it('returns 400 for a window outside the period', async () => {
    enqueue({ data: PERIOD })
    const res = await GET(
      createMockRequest('/api/reports/dimension-cross', { searchParams: { ...AXES, from_date: '2025-12-01' } }),
      noParams,
    )
    expect(res.status).toBe(400)
  })

  it('passes the axes, the range and the window to the generator', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockResolvedValue(REPORT)
    const res = await GET(
      createMockRequest('/api/reports/dimension-cross', {
        searchParams: { ...AXES, account_from: '3000', account_to: '3999', from_date: '2026-07-01', to_date: '2026-09-30' },
      }),
      noParams,
    )
    const { status, body } = await parseJsonResponse<{ data: DimensionCrossReport }>(res)
    expect(status).toBe(200)
    expect(body.data.total).toBe(1190)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      dimA: '1', dimB: '6', accountFrom: '3000', accountTo: '3999', fromDate: '2026-07-01', toDate: '2026-09-30',
    })
  })

  it('answers 503 REPORT_NOT_READY before the migration is applied', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValue(new DimensionCrossNotReadyError())
    const res = await GET(createMockRequest('/api/reports/dimension-cross', { searchParams: AXES }), noParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(503)
    expect(body.error.code).toBe('REPORT_NOT_READY')
  })

  it('answers 500 when the generation fails', async () => {
    enqueue({ data: PERIOD })
    mockGenerate.mockRejectedValue(new Error('boom'))
    const res = await GET(createMockRequest('/api/reports/dimension-cross', { searchParams: AXES }), noParams)
    expect(res.status).toBe(500)
  })
})

describe('GET /api/reports/dimension-cross/lines', () => {
  const PAGE: DimensionCrossLinesPage = { lines: [], has_more: false, next: null }

  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET_LINES(createMockRequest('/api/reports/dimension-cross/lines', { searchParams: AXES }), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for half a cursor', async () => {
    enqueue({ data: PERIOD })
    const res = await GET_LINES(
      createMockRequest('/api/reports/dimension-cross/lines', { searchParams: { ...AXES, after_date: '2026-03-01' } }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockLines).not.toHaveBeenCalled()
  })

  it('returns 404 when the period is not the company\'s', async () => {
    enqueue({ data: null })
    const res = await GET_LINES(createMockRequest('/api/reports/dimension-cross/lines', { searchParams: AXES }), noParams)
    expect(res.status).toBe(404)
  })

  it('reads the cell, a missing code being the untagged row or column, from the cursor on', async () => {
    enqueue({ data: PERIOD })
    mockLines.mockResolvedValue(PAGE)
    const res = await GET_LINES(
      createMockRequest('/api/reports/dimension-cross/lines', {
        searchParams: {
          ...AXES, code_a: 'NORR',
          after_date: '2026-03-01', after_voucher: '12', after_line: '11111111-1111-4111-8111-111111111111',
        },
      }),
      noParams,
    )
    expect(res.status).toBe(200)
    expect(mockLines).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      dimA: '1', dimB: '6', accountFrom: undefined, accountTo: undefined,
      codeA: 'NORR', codeB: null, fromDate: undefined, toDate: undefined,
      after: { date: '2026-03-01', voucher_number: 12, line_id: '11111111-1111-4111-8111-111111111111' },
    })
  })
})

describe('GET /api/reports/dimension-cross/xlsx and /pdf', () => {
  it('return 401 when not authenticated', async () => {
    unauthed()
    expect((await GET_XLSX(createMockRequest('/api/reports/dimension-cross/xlsx', { searchParams: AXES }), noParams)).status).toBe(401)
    expect((await GET_PDF(createMockRequest('/api/reports/dimension-cross/pdf', { searchParams: AXES }), noParams)).status).toBe(401)
  })

  it('return 400 for one dimension twice', async () => {
    const searchParams = { ...AXES, dim_b: '1' }
    expect((await GET_XLSX(createMockRequest('/api/reports/dimension-cross/xlsx', { searchParams }), noParams)).status).toBe(400)
    expect((await GET_PDF(createMockRequest('/api/reports/dimension-cross/pdf', { searchParams }), noParams)).status).toBe(400)
  })

  it('xlsx: A down, B across, Totalt last, the window and the measure stated, behind the ledger lease', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    mockGenerate.mockResolvedValue(REPORT)
    const res = await GET_XLSX(createMockRequest('/api/reports/dimension-cross/xlsx', { searchParams: AXES }), noParams)
    expect(res.status).toBe(200)
    expect(leaseMock).toHaveBeenCalledWith('report_export')
    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, blankrows: false })
    expect(rows[0]).toEqual(['Region / Kanal', 'WEB Webb', '(Utan dimension)', 'Totalt'])
    expect(rows[1]).toEqual(['Period: 2026-01-01 till 2026-12-31'])
    expect(rows[2]).toEqual(['Belopp: resultatet, konto 3000-8999'])
    expect(rows[3]).toEqual(['NORR Region Norr', 1000, 250, 1250])
    expect(rows[5]).toEqual(['Totalt', 1000, 190, 1190])
  })

  it('pdf: renders the report behind the ledger lease, 404 without company settings', async () => {
    enqueue({ data: PERIOD })
    enqueue({ data: null }) // company_settings
    expect((await GET_PDF(createMockRequest('/api/reports/dimension-cross/pdf', { searchParams: AXES }), noParams)).status).toBe(404)

    enqueue({ data: PERIOD })
    enqueue({ data: { company_name: 'Test AB', org_number: '5560000000' } })
    mockGenerate.mockResolvedValue(REPORT)
    const res = await GET_PDF(createMockRequest('/api/reports/dimension-cross/pdf', { searchParams: AXES }), noParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(leaseMock).toHaveBeenCalledWith('report_export')
  })
})
