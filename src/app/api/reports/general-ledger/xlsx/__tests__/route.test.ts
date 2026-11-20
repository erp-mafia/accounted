import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest } from '@/tests/helpers'
import type { GeneralLedgerReport } from '@/lib/reports/general-ledger'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

vi.mock('@/lib/reports/general-ledger', () => ({
  generateGeneralLedger: vi.fn(),
}))

import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateGeneralLedger)
const noParams = { params: Promise.resolve({}) }
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function ledger(dimensions?: Record<string, string>): GeneralLedgerReport {
  return {
    accounts: [
      {
        account_number: '3001',
        account_name: 'Försäljning',
        opening_balance: 0,
        lines: [
          {
            date: '2026-08-15',
            voucher_series: 'A',
            voucher_number: 12,
            journal_entry_id: 'je-12',
            description: 'Faktura 1001',
            source_type: 'manual',
            debit: 0,
            credit: 400,
            balance: -400,
            ...(dimensions ? { dimensions } : {}),
          },
        ],
        closing_balance: -400,
        total_debit: 0,
        total_credit: 400,
      },
    ],
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

describe('GET /api/reports/general-ledger/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/reports/general-ledger/xlsx'), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 when period_id is missing or the dimension filter is half given', async () => {
    expect((await GET(createMockRequest('/api/reports/general-ledger/xlsx'), noParams)).status).toBe(400)

    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    const res = await GET(
      createMockRequest('/api/reports/general-ledger/xlsx', { searchParams: { period_id: 'period-1', dim_no: '6' } }),
      noParams,
    )
    expect(res.status).toBe(400)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('adds a Dimensioner column naming each tag after its registry dimension', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    enqueue({ data: [{ sie_dim_no: 1, name: 'Kostnadsställe' }, { sie_dim_no: 6, name: 'Projekt' }] }) // dimensions
    mockGenerate.mockResolvedValue(ledger({ '6': 'P100', '1': 'KS01', '20': 'X1' }))

    const res = await GET(
      createMockRequest('/api/reports/general-ledger/xlsx', { searchParams: { period_id: 'period-1' } }),
      noParams,
    )
    expect(res.status).toBe(200)

    const rows = await sheetRows(res)
    expect(rows[0]).toEqual([
      'Konto', 'Kontonamn', 'Datum', 'Verifikat', 'Beskrivning', 'Källa', 'Debet', 'Kredit', 'Saldo', 'Dimensioner',
    ])
    const line = rows.find((r) => r[3] === 'A12')!
    expect(line[9]).toBe('Kostnadsställe KS01, Projekt P100, 20: X1')
    // The registry is read for the company, and only because a line is tagged.
    expect(findCalls('dimensions', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('leaves the file as it was for a ledger with no tagged line', async () => {
    enqueue({ data: { company_name: 'Test AB' } }) // company_settings
    enqueue({ data: PERIOD }) // fiscal_periods
    mockGenerate.mockResolvedValue(ledger())

    const res = await GET(
      createMockRequest('/api/reports/general-ledger/xlsx', { searchParams: { period_id: 'period-1' } }),
      noParams,
    )
    expect(res.status).toBe(200)

    const rows = await sheetRows(res)
    expect(rows[0]).toEqual(['Konto', 'Kontonamn', 'Datum', 'Verifikat', 'Beskrivning', 'Källa', 'Debet', 'Kredit', 'Saldo'])
    expect(findCalls('dimensions', 'select')).toEqual([])
  })
})
