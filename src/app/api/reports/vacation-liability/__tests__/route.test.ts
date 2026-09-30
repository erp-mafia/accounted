import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const routeCtx = createMockRouteParams({})
const call = (url: string) => GET(createMockRequest(url), routeCtx)

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/vacation-liability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/vacation-liability')>()
  return { ...actual, generateVacationLiability: vi.fn() }
})

vi.mock('@/lib/salary/semesterberedning', () => ({
  bookedVacationBalances: vi.fn(),
}))

// The PDF layout is not under test here: the renderer is a stub so the route
// test asserts only the HTTP contract.
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 stub', 'utf-8')),
}))
vi.mock('@/lib/reports/semesterskuld-pdf-template', () => ({
  SemesterskuldPDF: vi.fn().mockReturnValue({ type: 'Document' }),
}))

// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))

import { generateVacationLiability } from '@/lib/reports/vacation-liability'
import { bookedVacationBalances } from '@/lib/salary/semesterberedning'
import { SemesterskuldPDF } from '@/lib/reports/semesterskuld-pdf-template'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateVacationLiability)
const mockBooked = vi.mocked(bookedVacationBalances)
const mockPdf = vi.mocked(SemesterskuldPDF)

const PERIOD_ID = '11111111-1111-4111-8111-111111111111'

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

const sampleReport = {
  rows: [
    {
      employeeId: 'emp-1',
      employeeName: 'Anna Andersson',
      personnummerLast4: '0000',
      vacationRule: 'procentregeln',
      vacationDaysEntitled: 25,
      vacationDaysTaken: 5,
      vacationDaysRemaining: 20,
      vacationDaysSaved: 0,
      accruedAmount: 4200,
      accruedAvgifter: 1319.64,
      avgifterRate: 0.3142,
      advanceVacationDebt: 0,
      totalLiability: 5519.64,
      netLiability: 5519.64,
    },
  ],
  totals: {
    accruedAmount: 4200,
    accruedAvgifter: 1319.64,
    advanceVacationDebt: 0,
    totalLiability: 5519.64,
    netLiability: 5519.64,
  },
  asOfDate: '2026-12-31',
  vacationYearStart: '2026-01-01',
  closedYear: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
  mockGenerate.mockResolvedValue(sampleReport)
  mockBooked.mockResolvedValue({ ok: true, data: { booked2920: 5000, booked2940: 1319.64 } })
})

describe('GET /api/reports/vacation-liability', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await call('/api/reports/vacation-liability?year=2026')
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 400 on a malformed period_id or format', async () => {
    expect((await call('/api/reports/vacation-liability?period_id=nope')).status).toBe(400)
    expect((await call('/api/reports/vacation-liability?year=2026&format=docx')).status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 404 when the period does not belong to the company', async () => {
    enqueue({ data: null })
    const res = await call(`/api/reports/vacation-liability?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(404)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('reports as of the period end with the booked check', async () => {
    enqueue({ data: { period_end: '2026-06-30' } })
    const res = await call(`/api/reports/vacation-liability?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', '2026-06-30')
    expect(mockBooked).toHaveBeenCalledWith(supabase, 'company-1', '2026-06-30')
    const { body } = await parseJsonResponse<{ data: { check: Record<string, number> } }>(res)
    expect(body.data.check).toEqual({
      booked2920: 5000,
      booked2940: 1319.64,
      difference2920: 800,
      difference2940: 0,
    })
  })

  it('keeps the legacy year parameter as December 31', async () => {
    const res = await call('/api/reports/vacation-liability?year=2025')
    expect(res.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', '2025-12-31')
  })

  it('drops the check, not the report, when no period covers the date', async () => {
    mockBooked.mockResolvedValue({ ok: false, code: 'VALIDATION_ERROR' })
    const res = await call('/api/reports/vacation-liability?year=2026')
    const { body } = await parseJsonResponse<{ data: { check: unknown; rows: unknown[] } }>(res)
    expect(res.status).toBe(200)
    expect(body.data.check).toBeNull()
    expect(body.data.rows).toHaveLength(1)
  })

  it('downloads a PDF', async () => {
    enqueue({ data: { name: 'Testbolaget AB', org_number: '5560000001' } })
    const res = await call('/api/reports/vacation-liability?year=2026&format=pdf')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('semesterskuld-testbolaget-ab-20261231.pdf')
    expect(mockPdf).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Testbolaget AB', org_number: '5560000001' } }),
    )
  })

  it('downloads an xlsx', async () => {
    enqueue({ data: { name: 'Testbolaget AB', org_number: null } })
    const res = await call('/api/reports/vacation-liability?year=2026&format=xlsx')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(res.headers.get('Content-Disposition')).toContain('semesterskuld-testbolaget-ab-20261231.xlsx')
  })

  it('answers 500 without leaking the database message', async () => {
    mockGenerate.mockRejectedValue(new Error('relation "vacation_year_closures" does not exist'))
    const res = await call('/api/reports/vacation-liability?year=2026')
    expect(res.status).toBe(500)
    expect(JSON.stringify(await parseJsonResponse(res))).not.toMatch(/relation/)
  })
})
