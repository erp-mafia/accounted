import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The export holds the SIE read lease; its own tests cover that boundary.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

vi.mock('@/lib/reports/income-statement', () => ({
  generateIncomeStatement: vi.fn(),
}))

import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { GET } from '../xlsx/route'

const mockGenerate = vi.mocked(generateIncomeStatement)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function report() {
  return {
    revenue_sections: [],
    expense_sections: [],
    financial_sections: [],
    total_revenue: 1000,
    total_expenses: 400,
    total_financial: 0,
    net_result: 600,
    period: { start: '2026-01-01', end: '2026-12-31' },
  } as unknown as Awaited<ReturnType<typeof generateIncomeStatement>>
}

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/income-statement/xlsx', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/income-statement/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(request({}), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('names the bottom line Resultat före bokslutstransaktioner', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    mockGenerate.mockResolvedValue(report())

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(200)

    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets['Sammanfattning'], { header: 1, blankrows: false })
    expect(rows.slice(1)).toEqual([
      ['Sammanfattning', '', 'Rörelseresultat', 600],
      ['Sammanfattning', '', 'Resultat före bokslutstransaktioner', 600],
    ])
  })

  it('gives Bokslutsdispositioner and Skatter sheets of their own, not rows under Finansiella poster', async () => {
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    const section = (title: string, account: string, amount: number) => ({
      title,
      rows: [{ account_number: account, account_name: title, amount }],
      subtotal: amount,
    })
    mockGenerate.mockResolvedValue({
      ...report(),
      financial_sections: [
        section('Räntekostnader', '8410', -2000),
        section('Bokslutsdispositioner', '8811', -50000),
        section('Skatter och årets resultat', '8910', -68000),
      ],
      total_financial: -120000,
      net_result: -119400,
    } as unknown as Awaited<ReturnType<typeof generateIncomeStatement>>)

    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(200)

    const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    expect(workbook.SheetNames).toEqual(['Intäkter', 'Kostnader', 'Finansiella poster', 'Bokslutsdispositioner', 'Skatter', 'Sammanfattning'])
    const sheet = (name: string) =>
      XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, { header: 1, blankrows: false }).slice(1)
    expect(sheet('Finansiella poster')).toEqual([
      ['Räntekostnader', '8410', 'Räntekostnader', -2000],
      ['Räntekostnader', '', 'Summa Räntekostnader', -2000],
      ['Finansiella poster', '', 'Summa finansiella poster', -2000],
    ])
    expect(sheet('Skatter').at(-1)).toEqual(['Skatter', '', 'Summa skatter', -68000])
    expect(sheet('Sammanfattning')).toEqual([
      ['Sammanfattning', '', 'Rörelseresultat', 600],
      ['Sammanfattning', '', 'Resultat efter finansiella poster', -1400],
      ['Sammanfattning', '', 'Bokslutsdispositioner', -50000],
      ['Sammanfattning', '', 'Skatt på årets resultat', -68000],
      ['Sammanfattning', '', 'Resultat före bokslutstransaktioner', -119400],
    ])
  })
})
