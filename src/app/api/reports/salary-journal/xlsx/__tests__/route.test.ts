import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'
import type { SalaryJournalReport, SalaryJournalRow } from '@/lib/reports/salary-journal'

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

vi.mock('@/lib/reports/salary-journal', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reports/salary-journal')>('@/lib/reports/salary-journal')
  return { ...actual, generateSalaryJournal: vi.fn() }
})

import { generateSalaryJournal, salaryJournalGroupTotals, salaryJournalTotals } from '@/lib/reports/salary-journal'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateSalaryJournal)
const noParams = { params: Promise.resolve({}) }

function row(overrides: Partial<SalaryJournalRow>): SalaryJournalRow {
  return {
    employeeId: 'emp-1',
    employeeName: 'Anna Ek',
    personnummerLast4: '1234',
    employmentType: 'employee',
    personnelCategory: 'tjansteman',
    periodYear: 2026,
    periodMonth: 9,
    paymentDate: '2026-09-25',
    grossSalary: 30000,
    taxWithheld: 7000,
    netSalary: 23000,
    avgifterAmount: 9426,
    avgifterRate: 0.3142,
    vacationAccrual: 3600,
    vacationAccrualAvgifter: 1131.12,
    totalEmployerCost: 44157.12,
    sickDays: 0,
    vabDays: 0,
    parentalDays: 0,
    vacationDaysTaken: 0,
    salaryRunStatus: 'booked',
    ...overrides,
  }
}

function report(rows: SalaryJournalRow[]): SalaryJournalReport {
  return {
    rows,
    totals: salaryJournalTotals(rows),
    groupTotals: salaryJournalGroupTotals(rows),
    period: { year: 2026 },
  }
}

async function sheets(res: Response): Promise<Record<string, unknown[][]>> {
  const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
  return Object.fromEntries(
    workbook.SheetNames.map((name) => [
      name,
      XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, blankrows: false }),
    ]),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/salary-journal/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/reports/salary-journal/xlsx?year=2026'), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('puts the personnel category after Anställning: the category for employees, empty for owners', async () => {
    enqueue({ data: { company_name: 'Testbolaget AB' } })
    mockGenerate.mockResolvedValue(
      report([
        row({ employeeId: 'emp-1', employeeName: 'Anna Ek', personnelCategory: 'arbetare' }),
        row({ employeeId: 'emp-2', employeeName: 'Bo Ek', personnelCategory: 'tjansteman' }),
        row({ employeeId: 'emp-3', employeeName: 'Cia Ek', employmentType: 'company_owner', personnelCategory: null }),
      ]),
    )

    const res = await GET(createMockRequest('/api/reports/salary-journal/xlsx?year=2026'), noParams)

    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 2026, undefined, undefined)
    const book = await sheets(res)
    const journal = book['Lönejournal']
    const header = journal[0] as string[]
    const categoryColumn = header.indexOf('Personalkategori')
    expect(categoryColumn).toBe(header.indexOf('Anställning') + 1)
    expect(journal.slice(1).map((r) => r[categoryColumn] ?? '')).toEqual(['Arbetare', 'Tjänsteman', ''])
  })

  it('adds a totals sheet per category, owners and board on their own rows', async () => {
    enqueue({ data: { company_name: 'Testbolaget AB' } })
    mockGenerate.mockResolvedValue(
      report([
        row({ employeeId: 'emp-1', personnelCategory: 'arbetare', grossSalary: 30000, periodMonth: 8 }),
        row({ employeeId: 'emp-1', personnelCategory: 'arbetare', grossSalary: 31000, periodMonth: 9 }),
        row({ employeeId: 'emp-2', personnelCategory: 'tjansteman', grossSalary: 40000 }),
        row({ employeeId: 'emp-3', employmentType: 'company_owner', personnelCategory: null, grossSalary: 50000 }),
        row({ employeeId: 'emp-4', employmentType: 'board_member', personnelCategory: null, grossSalary: 5000 }),
      ]),
    )

    const res = await GET(createMockRequest('/api/reports/salary-journal/xlsx?year=2026'), noParams)

    expect(res.status).toBe(200)
    const totals = (await sheets(res))['Summa per kategori']
    expect(totals[0]).toEqual([
      'Kategori',
      'Anställda',
      'Bruttolön',
      'Skatt',
      'Nettolön',
      'Arbetsgivaravgifter',
      'Semesterlönereservation',
      'Semesterskuld avgifter',
      'Total arbetsgivarkostnad',
    ])
    expect(totals.slice(1).map((r) => [r[0], r[1], r[2]])).toEqual([
      ['Arbetare', 1, 61000],
      ['Tjänstemän', 1, 40000],
      ['Företagsledare', 1, 50000],
      ['Styrelse', 1, 5000],
    ])
  })

  it('returns 500 with a Swedish message when the report cannot be generated', async () => {
    enqueue({ data: { company_name: 'Testbolaget AB' } })
    mockGenerate.mockRejectedValue(new Error('boom'))

    const res = await GET(createMockRequest('/api/reports/salary-journal/xlsx?year=2026'), noParams)

    expect(res.status).toBe(500)
    expect(typeof (await res.json()).error).toBe('string')
  })
})
