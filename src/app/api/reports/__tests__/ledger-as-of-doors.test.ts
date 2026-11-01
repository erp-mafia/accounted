/**
 * The six dashboard doors of the two reskontra read one date check
 * (parseLedgerAsOfDate), the one v1 and MCP read. The JSON and xlsx routes had
 * none: as_of_date=garbage aged a not-yet-due invoice into the 90+ bucket. The
 * PDF routes checked the shape only, so 2026-02-31 passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mockSupabase = vi.hoisted(() => ({ auth: { getUser: vi.fn() }, from: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => Promise.resolve(mockSupabase) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
  StyleSheet: { create: (s: unknown) => s },
  Document: (p: unknown) => p,
  Page: (p: unknown) => p,
  Text: (p: unknown) => p,
  View: (p: unknown) => p,
}))
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
vi.mock('@/lib/reports/ar-ledger', () => ({ generateARLedger: vi.fn() }))
vi.mock('@/lib/reports/supplier-ledger', () => ({ generateSupplierLedger: vi.fn() }))

import { requireAuth } from '@/lib/auth/require-auth'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'
import { GET as arJson } from '../ar-ledger/route'
import { GET as arPdf } from '../ar-ledger/pdf/route'
import { GET as arXlsx } from '../ar-ledger/xlsx/route'
import { GET as supplierJson } from '../supplier-ledger/route'
import { GET as supplierPdf } from '../supplier-ledger/pdf/route'
import { GET as supplierXlsx } from '../supplier-ledger/xlsx/route'

const EMPTY_LEDGER = {
  entries: [],
  total_outstanding: 0,
  total_current: 0,
  total_overdue: 0,
  unpaid_count: 0,
  unconverted_fx_count: 0,
}

const DOORS = [
  { door: 'ar-ledger', get: arJson, generator: generateARLedger },
  { door: 'ar-ledger/pdf', get: arPdf, generator: generateARLedger },
  { door: 'ar-ledger/xlsx', get: arXlsx, generator: generateARLedger },
  { door: 'supplier-ledger', get: supplierJson, generator: generateSupplierLedger },
  { door: 'supplier-ledger/pdf', get: supplierPdf, generator: generateSupplierLedger },
  { door: 'supplier-ledger/xlsx', get: supplierXlsx, generator: generateSupplierLedger },
] as const

const call = (get: (typeof DOORS)[number]['get'], query: string) =>
  get(new Request(`http://localhost/api/reports/door${query}`), { params: Promise.resolve({}) } as never)

function settingsQuery() {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { company_name: 'Testbolaget AB', org_number: '5566778899' }, error: null }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: 'user-1', email: 'test@test.se' } as never,
    supabase: mockSupabase as never,
    error: null,
  })
  mockSupabase.from.mockImplementation(settingsQuery)
  vi.mocked(generateARLedger).mockResolvedValue(EMPTY_LEDGER as never)
  vi.mocked(generateSupplierLedger).mockResolvedValue(EMPTY_LEDGER as never)
})

describe.each(DOORS)('as_of_date at $door', ({ get, generator }) => {
  it('answers 401 without a session', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await call(get, '?as_of_date=2026-06-30')
    expect(res.status).toBe(401)
  })

  it.each([
    ['no date at all', 'garbage', 'ÅÅÅÅ-MM-DD'],
    ['a day the calendar lacks', '2026-02-31', 'kalendern'],
    ['a year out of range', '1999-12-31', 'mellan 2000'],
  ])('refuses %s with 400, the ledger never read', async (_what, value, message) => {
    const res = await call(get, `?as_of_date=${value}`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain(message)
    expect(generator).not.toHaveBeenCalled()
  })

  it('ages against a real date', async () => {
    const res = await call(get, '?as_of_date=2026-06-30')
    expect(res.status).toBe(200)
    expect(generator).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-06-30')
  })

  it('reads no date as today', async () => {
    const res = await call(get, '')
    expect(res.status).toBe(200)
    expect(generator).toHaveBeenCalledTimes(1)
  })
})
