import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ForaMonthlyReport } from '@/lib/salary/fora/monthly-report'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/salary/fora/monthly-report', () => ({
  generateForaMonthlyReport: vi.fn(),
}))

import { generateForaMonthlyReport } from '@/lib/salary/fora/monthly-report'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateForaMonthlyReport)
const noParams = { params: Promise.resolve({}) }

const REPORT: ForaMonthlyReport = {
  year: 2026,
  month: 10,
  filename: 'Fora_5565601712_202610.json',
  file: {
    source: 'Accounted',
    reports: [
      {
        refId: '202610',
        organizationNumber: '5565601712',
        employments: [
          { employeeId: '195408012230', firstName: 'Kalle', lastName: 'Hall', employmentEndDate: null, markups: [{ fokId: 'FOK306834', startDate: '20240101' }] },
        ],
        payrolls: [{ employeeId: '195408012230', firstName: 'Kalle', lastName: 'Hall', payMonth: '202610', payAmount: 31250 }],
      },
    ],
  },
  payrolls: [
    {
      employee_id: 'emp-1',
      employee_name: 'Kalle Hall',
      personnummer_masked: '19540801-XXXX',
      fok_id: 'FOK306834',
      pay_amount: 31250,
      employment_end: null,
    },
  ],
  total_pay_amount: 31250,
  salary_run_ids: ['run-1'],
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/salary/fora', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/salary/fora?year=2026&month=10'), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it.each(['', '?year=2026', '?year=2026&month=13', '?year=abc&month=10', '?year=2026&month=10&download=yes'])(
    'returns 400 for the query %j',
    async (query) => {
      const res = await GET(createMockRequest(`/api/salary/fora${query}`), noParams)
      expect(res.status).toBe(400)
      expect(mockGenerate).not.toHaveBeenCalled()
    },
  )

  it('answers the summary without the file (no full personnummer)', async () => {
    mockGenerate.mockResolvedValue({ ok: true, data: REPORT })

    const res = await GET(createMockRequest('/api/salary/fora?year=2026&month=10'), noParams)

    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, { companyId: 'company-1', year: 2026, month: 10 })
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(body.data).toMatchObject({ filename: 'Fora_5565601712_202610.json', employee_count: 1, total_pay_amount: 31250 })
    expect(body.data.file).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('195408012230')
  })

  it('downloads the JSON file with download=1', async () => {
    mockGenerate.mockResolvedValue({ ok: true, data: REPORT })

    const res = await GET(createMockRequest('/api/salary/fora?year=2026&month=10&download=1'), noParams)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toContain('Fora_5565601712_202610.json')
    expect(JSON.parse(await res.text())).toEqual(REPORT.file)
  })

  it('returns 400 FORA_REPORT_INCOMPLETE with the issues', async () => {
    mockGenerate.mockResolvedValue({
      ok: false,
      code: 'FORA_REPORT_INCOMPLETE',
      issues: [{ code: 'FORA_NO_CODED_EMPLOYEES', message: 'Ingen anställd har en Fora-kod.' }],
    })

    const res = await GET(createMockRequest('/api/salary/fora?year=2026&month=10'), noParams)

    expect(res.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: { code: string; details: { issues: unknown[] } } }>(res)
    expect(body.error.code).toBe('FORA_REPORT_INCOMPLETE')
    expect(body.error.details.issues).toEqual([expect.objectContaining({ code: 'FORA_NO_CODED_EMPLOYEES' })])
  })

  it('returns 404 when the company is gone and 500 on a database error', async () => {
    mockGenerate.mockResolvedValue({ ok: false, code: 'COMPANY_NOT_FOUND' })
    expect((await GET(createMockRequest('/api/salary/fora?year=2026&month=10'), noParams)).status).toBe(404)

    mockGenerate.mockResolvedValue({ ok: false, code: 'DB_ERROR', cause: { message: 'boom' } })
    expect((await GET(createMockRequest('/api/salary/fora?year=2026&month=10'), noParams)).status).toBe(500)
  })
})
