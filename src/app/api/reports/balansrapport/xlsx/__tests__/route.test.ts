import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'
import type { BalansrapportReport } from '@/types'

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

vi.mock('@/lib/reports/balansrapport', () => ({
  generateBalansrapport: vi.fn(),
}))

import { generateBalansrapport } from '@/lib/reports/balansrapport'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateBalansrapport)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function account(account_number: string, account_name: string, ib: number, ub: number) {
  return { account_number, account_name, ib, ub, period_change: ub - ib }
}

function report(): BalansrapportReport {
  return {
    groups: [
      {
        class: 1,
        class_label: '1 Tillgångar',
        sections: [
          {
            key: 'anlaggningstillgangar',
            label: 'Anläggningstillgångar',
            total_label: 'Summa anläggningstillgångar',
            rows: [],
            sections: [
              {
                key: 'materiellaAnlaggningstillgangar',
                label: 'Materiella anläggningstillgångar',
                total_label: 'Summa materiella anläggningstillgångar',
                rows: [account('1220', 'Inventarier', 80_000, 80_000), account('1229', 'Ack avskr', -16_000, -20_000)],
                sections: [],
                subtotal_ib: 64_000,
                subtotal_change: -4_000,
                subtotal_ub: 60_000,
              },
            ],
            subtotal_ib: 64_000,
            subtotal_change: -4_000,
            subtotal_ub: 60_000,
          },
          {
            key: 'unclassified',
            label: 'Ej klassificerade konton',
            total_label: 'Summa ej klassificerade konton',
            rows: [account('1200', 'Maskiner', 0, 500)],
            sections: [],
            subtotal_ib: 0,
            subtotal_change: 500,
            subtotal_ub: 500,
          },
        ],
        subtotal_ib: 64_000,
        subtotal_change: -3_500,
        subtotal_ub: 60_500,
      },
    ],
    total_assets_ub: 60_500,
    total_equity_liabilities_ub: 0,
    beraknat_resultat: 60_500,
    is_balanced: true,
    period: { start: '2026-01-01', end: '2026-12-31' },
  }
}

async function sheetRows(res: Response): Promise<unknown[][]> {
  const workbook = XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
})

describe('GET /api/reports/balansrapport/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/reports/balansrapport/xlsx'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(createMockRequest('/api/reports/balansrapport/xlsx'), noParams)
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 500 with a message when the period does not exist', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: null }) // fiscal_periods
    mockGenerate.mockRejectedValue(new Error('Fiscal period not found'))

    const res = await GET(
      createMockRequest('/api/reports/balansrapport/xlsx', { searchParams: { period_id: 'missing' } }),
      noParams,
    )
    expect(res.status).toBe(500)
  })

  it('writes each account under its ÅRL heading, with a Summa line per heading', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(report())

    const res = await GET(
      createMockRequest('/api/reports/balansrapport/xlsx', { searchParams: { period_id: 'period-1' } }),
      noParams,
    )
    expect(res.status).toBe(200)

    const rows = await sheetRows(res)
    expect(rows[0]).toEqual(['Grupp', 'Avsnitt', 'Konto', 'Kontonamn', 'IB', 'Periodförändring', 'UB'])
    expect(rows.slice(1).map((r) => [r[1], r[2], r[3], r[6]])).toEqual([
      ['Materiella anläggningstillgångar', '1220', 'Inventarier', 80_000],
      ['Materiella anläggningstillgångar', '1229', 'Ack avskr', -20_000],
      ['Materiella anläggningstillgångar', '', 'Summa materiella anläggningstillgångar', 60_000],
      ['Anläggningstillgångar', '', 'Summa anläggningstillgångar', 60_000],
      ['Ej klassificerade konton', '1200', 'Maskiner', 500],
      ['Ej klassificerade konton', '', 'Summa ej klassificerade konton', 500],
      ['', '', 'Summa 1 Tillgångar', 60_500],
      ['', '', 'Beräknat resultat', 60_500],
    ])
  })
})
