/**
 * Contract tests for the kassaflödesanalys PDF route.
 *
 * Two of these are load-bearing for the client. `KassaflodesanalysClient` now
 * fetches this route with `downloadFile` instead of assigning
 * `window.location.href`, which means:
 *
 *   1. The client names the saved file itself, as
 *      `kassaflodesanalys-<report.period_start>.pdf`. It reads period_start from
 *      the sibling JSON route, which returns the same generator output this
 *      route renders, so the two names agree. The Content-Disposition assertion
 *      below pins the server half of that agreement: change the filename here
 *      and the archived statutory artefact silently gets a different name than
 *      the one the browser writes.
 *   2. The route's error bodies are now read and shown in a toast instead of
 *      being rendered as a raw JSON document after the browser navigated the
 *      whole app away. `getErrorMessage` must therefore find a real sentence in
 *      them rather than falling back to the generic HTTP status text, which is
 *      what the last test checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

// Stub the renderer so no real PDF layout runs. The primitives the template
// imports at module load (StyleSheet.create) still have to exist.
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
  StyleSheet: { create: (s: unknown) => s },
  Document: (p: unknown) => p,
  Page: (p: unknown) => p,
  Text: (p: unknown) => p,
  View: (p: unknown) => p,
}))

vi.mock('@/lib/reports/kassaflodesanalys', () => ({
  generateKassaflodesanalys: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'

const mockUser = { id: 'user-1', email: 'test@test.se' }

const PERIOD = { period_start: '2025-01-01', period_end: '2025-12-31' }

function makeReport() {
  return {
    fiscal_period_id: 'period-1',
    ...PERIOD,
    lopande: {
      resultat_efter_finansiella_poster: 120000,
      avskrivningar: 20000,
      ovriga_ej_kassaflodesposter: 0,
      delta_kortfristiga_fordringar: -5000,
      delta_varulager: 0,
      delta_kortfristiga_skulder: 3000,
      skatt_betald: -25000,
      total: 113000,
    },
    investerings: {
      forvarv_anlaggningar: -40000,
      avyttring_anlaggningar: 0,
      total: -40000,
    },
    finansierings: {
      delta_lan: 0,
      utdelningar: -30000,
      nyemission: 0,
      erhallna_aktieagartillskott: 0,
      total: -30000,
    },
    total_cash_flow: 43000,
    reconciliation: {
      opening_cash_1xxx: 100000,
      closing_cash_1xxx: 143000,
      delta_actual: 43000,
      delta_calculated: 43000,
      mismatch_amount: 0,
      is_reconciled: true,
    },
  }
}

/** One chain object serves both queries: select/eq chain, single resolves. */
function tableQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error: null }),
  }
}

let periodRow: unknown = PERIOD
let companyRow: unknown = { company_name: 'Testbolaget AB', org_number: '5566778899' }

function makeRequest(query = '') {
  return new Request(`http://localhost/api/reports/kassaflodesanalys/pdf${query}`)
}

function call(query = '') {
  return GET(makeRequest(query), { params: Promise.resolve({}) } as never)
}

describe('GET /api/reports/kassaflodesanalys/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    periodRow = PERIOD
    companyRow = { company_name: 'Testbolaget AB', org_number: '5566778899' }
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    mockSupabase.from.mockImplementation((table: string) =>
      tableQuery(table === 'fiscal_periods' ? periodRow : companyRow),
    )
    vi.mocked(generateKassaflodesanalys).mockResolvedValue(makeReport() as never)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await call('?period_id=period-1')
    expect(res.status).toBe(401)
    expect(generateKassaflodesanalys).not.toHaveBeenCalled()
  })

  it('returns 400 when period_id is missing', async () => {
    const res = await call()
    expect(res.status).toBe(400)
    expect(generateKassaflodesanalys).not.toHaveBeenCalled()
  })

  it('refuses to render when the fiscal period cannot be read', async () => {
    // An identifiable period is part of räkenskapsinformation (BFL 7 kap): a
    // PDF that cannot be archived with the period it refers to is not produced.
    periodRow = null

    const res = await call('?period_id=missing')
    expect(res.status).toBe(400)
    expect(generateKassaflodesanalys).not.toHaveBeenCalled()
  })

  it('returns 404 when company settings are missing', async () => {
    companyRow = null

    const res = await call('?period_id=period-1')
    expect(res.status).toBe(404)
    expect(generateKassaflodesanalys).not.toHaveBeenCalled()
  })

  it('names the file the way the client saves it', async () => {
    const res = await call('?period_id=period-1')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    // KassaflodesanalysClient builds exactly this name from the report it
    // already holds. Both sides read period_start from the same generator
    // output, so this literal is the contract between them.
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="kassaflodesanalys-2025-01-01.pdf"',
    )
    expect(generateKassaflodesanalys).toHaveBeenCalledWith(mockSupabase, 'company-1', 'period-1')
  })

  it('returns 500 when the generator throws', async () => {
    vi.mocked(generateKassaflodesanalys).mockRejectedValue(new Error('boom'))

    const res = await call('?period_id=period-1')
    expect(res.status).toBe(500)
  })

  it('answers failures with a body the download toast can show', async () => {
    // The client passes the parsed body to getErrorMessage. If a body carried
    // no recognisable sentence, the user would get the generic status text
    // ("Förfrågan innehåller ogiltiga uppgifter") and learn nothing about which
    // period or setting is actually missing.
    periodRow = null
    const badPeriod = await call('?period_id=missing')
    const badPeriodBody = await badPeriod.json()
    expect(getErrorMessage(badPeriodBody, { statusCode: 400 })).toContain(
      'Räkenskapsperioden kunde inte läsas',
    )

    periodRow = PERIOD
    companyRow = null
    const noSettings = await call('?period_id=period-1')
    const noSettingsBody = await noSettings.json()
    expect(getErrorMessage(noSettingsBody, { statusCode: 404 })).toBe(
      'Företagsinställningar saknas',
    )
  })
})

// The shared route-wrapper tests cover the database read lease.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEPeriodRead: (_client: unknown, _company: string, _purpose: string, read: () => Promise<unknown>) => read(),
}))
