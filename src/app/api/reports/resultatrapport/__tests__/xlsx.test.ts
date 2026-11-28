/**
 * The resultatrapport's Excel: class 8 in the resultaträkning's blocks, with
 * Resultat efter finansiella poster between them. The generator (tested in
 * lib/reports) makes the blocks; the route lays them out.
 */
import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createMockRequest, createQueuedMockSupabase } from '@/tests/helpers'
import type { ResultatrapportReport, ResultatrapportRow } from '@/types'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))
vi.mock('@/lib/reports/resultatrapport', () => ({ generateResultatrapport: vi.fn() }))

import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { GET } from '../xlsx/route'

const mockGenerate = vi.mocked(generateResultatrapport)
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }
const noParams = { params: Promise.resolve({}) }

const row = (account_number: string, account_name: string, current_period: number, prior_period = 0): ResultatrapportRow => ({
  account_number,
  account_name,
  current_period,
  prior_period,
})

const interest = row('8410', 'Räntekostnader', -3000, -2000)
const disposition = row('8811', 'Avsättning till periodiseringsfond', -50000)
const tax = row('8910', 'Skatt som belastar årets resultat', -68000)

const REPORT: ResultatrapportReport = {
  groups: [
    {
      class: 3,
      class_label: '3 Rörelsens inkomster/intäkter',
      rows: [row('3001', 'Försäljning', 500000, 400000)],
      subtotal_current: 500000,
      subtotal_prior: 400000,
    },
    {
      class: 8,
      class_label: '8 Finansiella poster och bokslutsdispositioner',
      rows: [interest, disposition, tax],
      subtotal_current: -121000,
      subtotal_prior: -2000,
      subgroups: [
        {
          key: 'finansiella_poster',
          label: 'Finansiella poster',
          total_label: 'Summa finansiella poster',
          above_result_after_financial: true,
          rows: [interest],
          subtotal_current: -3000,
          subtotal_prior: -2000,
        },
        {
          key: 'bokslutsdispositioner',
          label: 'Bokslutsdispositioner',
          total_label: 'Summa bokslutsdispositioner',
          above_result_after_financial: false,
          rows: [disposition],
          subtotal_current: -50000,
          subtotal_prior: 0,
        },
        {
          key: 'skatter',
          label: 'Skatter',
          total_label: 'Summa skatter',
          above_result_after_financial: false,
          rows: [tax],
          subtotal_current: -68000,
          subtotal_prior: 0,
        },
      ],
    },
  ],
  result_after_financial: { label: 'Resultat efter finansiella poster', current: 497000, prior: 398000 },
  net_result_current: 379000,
  net_result_prior: 398000,
  period: { start: '2026-01-01', end: '2026-12-31' },
  prior_period: { start: '2025-01-01', end: '2025-12-31' },
}

const request = (searchParams: Record<string, string>) =>
  createMockRequest('/api/reports/resultatrapport/xlsx', { searchParams })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/resultatrapport/xlsx', () => {
  it('401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await GET(request({ period_id: 'p1' }), noParams)
    expect(res.status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('400 without period_id', async () => {
    const res = await GET(request({}), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('404 PERIOD_NOT_FOUND for a period that is not the company\'s', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: null }) // fiscal_periods
    const res = await GET(request({ period_id: 'p1' }), noParams)
    expect(res.status).toBe(404)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('lists class 8 by block with Resultat efter finansiella poster after the finansiella poster', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(REPORT)

    const res = await GET(request({ period_id: 'p1' }), noParams)
    expect(res.status).toBe(200)

    const book = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!]!, { header: 1, blankrows: false })
    expect(rows.slice(1)).toEqual([
      ['3 Rörelsens inkomster/intäkter', '3001', 'Försäljning', 500000, 400000],
      ['3 Rörelsens inkomster/intäkter', '', 'Summa 3 Rörelsens inkomster/intäkter', 500000, 400000],
      ['Finansiella poster', '8410', 'Räntekostnader', -3000, -2000],
      ['Finansiella poster', '', 'Summa finansiella poster', -3000, -2000],
      ['Resultat', '', 'Resultat efter finansiella poster', 497000, 398000],
      ['Bokslutsdispositioner', '8811', 'Avsättning till periodiseringsfond', -50000, 0],
      ['Bokslutsdispositioner', '', 'Summa bokslutsdispositioner', -50000, 0],
      ['Skatter', '8910', 'Skatt som belastar årets resultat', -68000, 0],
      ['Skatter', '', 'Summa skatter', -68000, 0],
      ['Resultat', '', 'Beräknat resultat', 379000, 398000],
    ])
  })
})
