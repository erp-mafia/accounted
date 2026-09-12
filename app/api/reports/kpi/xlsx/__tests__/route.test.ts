import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { KPIReport } from '@/types'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// The heavy report generators are stubbed: this suite is about the supplier
// figures. The pure builders the KPI JSON hot path uses stay real so the
// cross-route consistency test compares two genuinely computed reports.
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/reports/ar-ledger', () => ({
  generateARLedger: vi.fn(),
}))
vi.mock('@/lib/reports/income-statement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/income-statement')>()
  return { ...actual, generateIncomeStatement: vi.fn() }
})
vi.mock('@/lib/reports/monthly-breakdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/monthly-breakdown')>()
  return { ...actual, generateMonthlyBreakdown: vi.fn() }
})

import { GET } from '../route'
import { GET as GET_JSON } from '../../route'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateMonthlyBreakdown } from '@/lib/reports/monthly-breakdown'

const mockTrialBalance = vi.mocked(generateTrialBalance)
const mockARLedger = vi.mocked(generateARLedger)
const mockIncomeStatement = vi.mocked(generateIncomeStatement)
const mockMonthlyBreakdown = vi.mocked(generateMonthlyBreakdown)

const noParams = { params: Promise.resolve({}) }

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

const PERIOD = {
  period_start: '2026-01-01',
  period_end: '2026-03-31',
  is_closed: false,
}

function supplierRow(
  overrides: Partial<{
    supplier_id: string
    total: number
    total_sek: number | null
    currency: string
    exchange_rate: number | null
    supplier: { id: string; name: string }
  }> = {}
) {
  const supplierId = overrides.supplier_id ?? 'sup-1'
  return {
    supplier_id: supplierId,
    total: 100,
    total_sek: null,
    currency: 'SEK',
    exchange_rate: null,
    supplier: { id: supplierId, name: 'Leverantören AB' },
    ...overrides,
  }
}

/**
 * An ordinary Swedish supplier invoice: currency SEK, no exchange rate and
 * `total_sek` NULL because no conversion ever ran.
 */
const SEK_ONLY_ROWS = [
  supplierRow({ supplier_id: 'sup-1', total: 1250, supplier: { id: 'sup-1', name: 'Städbolaget AB' } }),
  supplierRow({ supplier_id: 'sup-1', total: 750.5, supplier: { id: 'sup-1', name: 'Städbolaget AB' } }),
  supplierRow({
    supplier_id: 'sup-2',
    total: 400,
    supplier: { id: 'sup-2', name: 'Kontorsvaror AB' },
  }),
]

const MIXED_ROWS = [
  supplierRow({ supplier_id: 'sup-1', total: 1000, supplier: { id: 'sup-1', name: 'Svensk Lev AB' } }),
  supplierRow({
    supplier_id: 'sup-1',
    total: 100,
    currency: 'EUR',
    exchange_rate: 11.4567,
    supplier: { id: 'sup-1', name: 'Svensk Lev AB' },
  }),
  supplierRow({
    supplier_id: 'sup-2',
    total: 200,
    total_sek: 2300,
    currency: 'EUR',
    exchange_rate: 11.5,
    supplier: { id: 'sup-2', name: 'Euro Supplier GmbH' },
  }),
  // USD without a rate and without a SEK total: unconvertible.
  supplierRow({
    supplier_id: 'sup-3',
    total: 500,
    currency: 'USD',
    supplier: { id: 'sup-3', name: 'US Vendor Inc' },
  }),
]

function xlsxRequest(searchParams: Record<string, string> = { period_id: 'period-1' }) {
  return createMockRequest('/api/reports/kpi/xlsx', { searchParams })
}

/** Queue the four responses the xlsx route consumes, in call order. */
function enqueueXlsx(supplierRows: unknown[]) {
  enqueue({ data: PERIOD }) // fiscal_periods
  enqueue({ data: { company_name: 'Acme AB' } }) // company_settings
  enqueue({ data: [] }) // invoices (paid)
  enqueue({ data: supplierRows }) // supplier_invoices
}

/** Parse the produced workbook. The response body can only be read once. */
async function readWorkbook(res: Response): Promise<XLSX.WorkBook> {
  const buf = Buffer.from(await res.arrayBuffer())
  return XLSX.read(new Uint8Array(buf), { type: 'array' })
}

/** Read one sheet back out of the workbook as label/value pairs. */
function sheetRows(wb: XLSX.WorkBook, sheetName: string): [string, unknown][] {
  const sheet = wb.Sheets[sheetName]
  expect(sheet, `sheet ${sheetName} missing`).toBeDefined()
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 })
  // Drop the header row.
  return rows.slice(1).map((r) => [String(r[0]), r[1]] as [string, unknown])
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  authed()
  mockARLedger.mockResolvedValue({ total_outstanding: 0, total_overdue: 0 } as never)
  mockIncomeStatement.mockResolvedValue({
    revenue_sections: [],
    total_revenue: 0,
    expense_sections: [],
    total_expenses: 0,
    financial_sections: [],
    total_financial: 0,
    net_result: 0,
    period: { start: '2026-01-01', end: '2026-03-31' },
  })
  mockTrialBalance.mockResolvedValue({ rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true })
  mockMonthlyBreakdown.mockResolvedValue({ months: [] })
})

describe('GET /api/reports/kpi/xlsx', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const res = await GET(xlsxRequest(), noParams)
    expect(res.status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await GET(xlsxRequest({}), noParams)
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown fiscal period', async () => {
    enqueue({ data: null }) // fiscal_periods
    enqueue({ data: null }) // company_settings
    const res = await GET(xlsxRequest(), noParams)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('fills Topp leverantörer for a SEK-only company whose total_sek is NULL', async () => {
    // Headline regression: reading total_sek alone produced an empty sheet for
    // every ordinary Swedish company.
    enqueueXlsx(SEK_ONLY_ROWS)

    const res = await GET(xlsxRequest(), noParams)
    expect(res.status).toBe(200)

    expect(sheetRows(await readWorkbook(res), 'Topp leverantörer')).toEqual([
      ['Städbolaget AB', 2000.5],
      ['Kontorsvaror AB', 400],
    ])
  })

  it('aggregates mixed SEK/EUR rows and reports the unconvertible FX invoice', async () => {
    enqueueXlsx(MIXED_ROWS)

    const res = await GET(xlsxRequest(), noParams)
    expect(res.status).toBe(200)

    const wb = await readWorkbook(res)
    expect(sheetRows(wb, 'Topp leverantörer')).toEqual([
      ['Euro Supplier GmbH', 2300],
      ['Svensk Lev AB', 2145.67],
    ])

    // The 500 USD row is neither converted at a made-up rate nor dropped in
    // silence: the export states how many rows it could not convert.
    expect(sheetRows(wb, 'Nyckeltal (övrigt)')).toContainEqual([
      'Ej omräknade valutafakturor (leverantörer)',
      1,
    ])
  })
})

describe('KPI JSON and xlsx agree', () => {
  it('reports identical supplier totals for the same company and period', async () => {
    // JSON route (hot path) queue order.
    enqueue({ data: { id: 'period-1', company_id: 'company-1', ...PERIOD, opening_balance_entry_id: null } })
    enqueue({ data: { tb: [], tb_ex_year_end: [], ob: [], monthly: [] } }) // aggregates RPC
    enqueue({ data: [] }) // compute_prior_opening_balances
    enqueue({ data: [] }) // chart_of_accounts
    enqueue({ data: null }) // extension_data prefs
    enqueue({ data: [] }) // invoices
    enqueue({ data: MIXED_ROWS }) // supplier_invoices

    const jsonRes = await GET_JSON(
      createMockRequest('/api/reports/kpi', { searchParams: { period_id: 'period-1' } }),
      noParams
    )
    const { body } = await parseJsonResponse<{ data: KPIReport }>(jsonRes)

    // xlsx route over the identical supplier rows.
    enqueueXlsx(MIXED_ROWS)
    const xlsxRes = await GET(xlsxRequest(), noParams)
    const wb = await readWorkbook(xlsxRes)
    const suppliers = sheetRows(wb, 'Topp leverantörer')
    const other = sheetRows(wb, 'Nyckeltal (övrigt)')

    expect(suppliers).toEqual(
      body.data.topSuppliers.map((s) => [s.supplier_name, s.total])
    )
    expect(other).toContainEqual([
      'Ej omräknade valutafakturor (leverantörer)',
      body.data.topSuppliersUnconvertedFxCount,
    ])
    expect(body.data.topSuppliersUnconvertedFxCount).toBe(1)
  })
})

// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
