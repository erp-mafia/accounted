import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const mockSupabase = {
  auth: { getUser: vi.fn() },
  from: vi.fn(),
  rpc: vi.fn(),
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

// Deliberately NOT mocking @/lib/reports/vat-declaration: the test drives the
// real calculateVatDeclaration -> fetchVatAccountTotals path off the rpc mock,
// so the ruta assertions below prove the öre-exact projection end to end.

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { rcInputTotalsFromDeclaration } from '@/lib/reports/vat-declaration'
import { runVatDeclarationChecks } from '@/lib/reports/vat-declaration-checks'

const mockUser = { id: 'user-1', email: 'test@test.se' }

/** Wire payload as returned by the get_vat_declaration_totals RPC. */
function rpcPayload() {
  return {
    totals: [
      { account_number: '3001', debit: 0, credit: 100000 },
      { account_number: '2611', debit: 0, credit: 25000 },
      { account_number: '2641', debit: 3200, credit: 0 },
    ],
    settlement_shaped_entries: [],
    source_type_counts: { invoice_created: 2, bank_transaction: 3, manual: 1 },
  }
}

function makeRequest(query: string) {
  return new Request(`http://localhost/api/reports/vat-declaration${query}`)
}

/**
 * chart_of_accounts builder for fetchDynamicRuta05Accounts: which of the
 * company's own class 3 accounts carry a "Standard moms" and therefore belong
 * in ruta 05. Empty by default, i.e. a plain BAS chart.
 */
function chartBuilder(accounts: Array<{ account_number: string; default_vat_rate: number }> = []) {
  const result = { data: accounts, error: null }
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'not', 'order']) b[m] = vi.fn().mockReturnValue(b)
  b.range = vi.fn().mockResolvedValue(result)
  b.then = (resolve: (v: unknown) => void) => resolve(result)
  return b
}

describe('GET /api/reports/vat-declaration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    mockSupabase.rpc.mockResolvedValue({ data: rpcPayload(), error: null })
    mockSupabase.from.mockImplementation(() => chartBuilder())
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(
      makeRequest('?periodType=quarterly&year=2026&period=3'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(401)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns 400 when required params are missing', async () => {
    const res = await GET(makeRequest(''), { params: Promise.resolve({}) })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VAT_REPORT_MISSING_PARAMS')
  })

  it('returns 400 for an invalid periodType', async () => {
    const res = await GET(
      makeRequest('?periodType=weekly&year=2026&period=1'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VAT_REPORT_INVALID_PERIOD_TYPE')
  })

  it('returns 400 for an invalid year', async () => {
    const res = await GET(
      makeRequest('?periodType=monthly&year=1999&period=1'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VAT_REPORT_INVALID_YEAR')
  })

  it('returns 400 for out-of-range periods per period type', async () => {
    for (const query of [
      '?periodType=monthly&year=2026&period=13',
      '?periodType=quarterly&year=2026&period=5',
      '?periodType=yearly&year=2026&period=2',
    ]) {
      const res = await GET(makeRequest(query), { params: Promise.resolve({}) })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VAT_REPORT_INVALID_PERIOD')
    }
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('happy path quarterly: öre-exact rutor from a single RPC round trip', async () => {
    const res = await GET(
      makeRequest('?periodType=quarterly&year=2026&period=3'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.data.rutor.ruta05).toBe(100000)
    expect(body.data.rutor.ruta10).toBe(25000)
    expect(body.data.rutor.ruta48).toBe(3200)
    expect(body.data.rutor.ruta49).toBe(21800)
    expect(body.data.breakdown.invoices.base25).toBe(100000)
    expect(body.data.invoiceCount).toBe(2)
    expect(body.data.transactionCount).toBe(3)
    expect(body.data.periodLabel).toBe('Kvartal 3 2026')

    // Regression guard: the dead company_settings round trip is gone and
    // resolvePeriodDates makes no DB call for calendar quarters. The only
    // table read left is chart_of_accounts, for the company's own ruta 05
    // accounts (#1261).
    expect(mockSupabase.from.mock.calls.map(([t]) => t)).toEqual(['chart_of_accounts'])
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'get_vat_declaration_totals',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_start: '2026-07-01',
        p_end: '2026-09-30',
      }),
    )
  })

  it('happy path monthly: no period lookup, one RPC', async () => {
    const res = await GET(
      makeRequest('?periodType=monthly&year=2026&period=7'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.rutor.ruta49).toBe(21800)
    expect(body.data.periodLabel).toBe('Juli 2026')

    expect(mockSupabase.from).not.toHaveBeenCalledWith('fiscal_periods')
    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'get_vat_declaration_totals',
      expect.objectContaining({ p_start: '2026-07-01', p_end: '2026-07-31' }),
    )
  })

  // The declaration is what the momsdeklaration UI runs its local
  // "Kontroll av underlaget" checks on, and that client has no ledger access of
  // its own. Without the 2645/2647 pair on the response it could only compare
  // rutor 30-32 against the ruta 48 aggregate, where ordinary debiterad ingående
  // moms on 2641 hides a missing beräknad ingående moms completely.
  describe('rcInputAccountTotals travels with the response', () => {
    /** The masking ledger: 50 000 kr RC output, underlag booked, no 2645/2647. */
    function maskedRcPayload() {
      return {
        totals: [
          { account_number: '4535', debit: 200000, credit: 0 }, // ruta 21 basis
          { account_number: '2614', debit: 0, credit: 50000 },  // ruta 30
          { account_number: '2641', debit: 60000, credit: 0 },  // ordinary input VAT
        ],
        settlement_shaped_entries: [],
        source_type_counts: {},
      }
    }

    async function fetchDeclaration() {
      const res = await GET(
        makeRequest('?periodType=monthly&year=2026&period=1'),
        { params: Promise.resolve({}) },
      )
      expect(res.status).toBe(200)
      return (await res.json()).data
    }

    it('carries both accounts, zeros included, on an ordinary SEK period', async () => {
      const data = await fetchDeclaration()
      // The default fixture has no reverse charge at all: the pair is still
      // present, so a client can tell "no RC activity" from "field missing".
      expect(data.rcInputAccountTotals).toEqual({
        '2645': { debit: 0, credit: 0 },
        '2647': { debit: 0, credit: 0 },
      })
      expect(runVatDeclarationChecks(data.rutor, rcInputTotalsFromDeclaration(data))).toEqual([])
    })

    it('lets the client run the sharp RC input check off the response alone', async () => {
      mockSupabase.rpc.mockResolvedValue({ data: maskedRcPayload(), error: null })
      const data = await fetchDeclaration()

      expect(data.rutor.ruta30).toBe(50000)
      expect(data.rutor.ruta48).toBe(60000)
      expect(data.rcInputAccountTotals['2645']).toEqual({ debit: 0, credit: 0 })

      // Same call the momsdeklaration view makes.
      const checks = runVatDeclarationChecks(data.rutor, rcInputTotalsFromDeclaration(data))
      const mismatch = checks.find((c) => c.code === 'RC_INPUT_VAT_MISMATCH')
      expect(mismatch?.status).toBe('WARNING')
      // \s, not a literal space: sv-SE groups thousands with a no-break space.
      expect(mismatch?.message).toMatch(/50\s000 kr saknas/)

      // Ruta 48 alone: silent, which is the state the wiring replaced.
      expect(runVatDeclarationChecks(data.rutor)).toEqual([])
    })
  })

  it('returns the VAT_REPORT_GENERATION_FAILED envelope when the RPC errors', async () => {
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    })
    const res = await GET(
      makeRequest('?periodType=quarterly&year=2026&period=3'),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('VAT_REPORT_GENERATION_FAILED')
  })
})
