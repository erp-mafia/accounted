import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()
const mockAuth = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    from: (...args: unknown[]) => mockFrom(...args),
    auth: { getUser: () => mockAuth() },
  }),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

interface ChainResult {
  data?: unknown
  error?: unknown
}

function mockChain(result: ChainResult) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'lte', 'gte']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(result)
  return chain
}

function mkReq(query = '') {
  return new Request(`http://localhost/api/bookkeeping/voucher-sequences/next${query}`)
}

function mkParams() {
  return { params: Promise.resolve({}) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/bookkeeping/voucher-sequences/next', () => {
  it('returns 401 when not authenticated', async () => {
    mockAuth.mockResolvedValue({ data: { user: null } })

    const response = await GET(mkReq(), mkParams())
    const body = await response.json()

    expect(response.status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns last_number + 1 when sequence exists', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fiscal_periods') {
        return mockChain({ data: { id: 'period-1' }, error: null })
      }
      if (table === 'company_settings') {
        return mockChain({ data: { default_voucher_series: 'A' }, error: null })
      }
      if (table === 'voucher_sequences') {
        return mockChain({ data: { last_number: 57 }, error: null })
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(mkReq(), mkParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ next: 58, series: 'A', fiscal_period_id: 'period-1' })
  })

  it('returns 1 when no sequence row exists yet', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fiscal_periods') {
        return mockChain({ data: { id: 'period-1' }, error: null })
      }
      if (table === 'company_settings') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'voucher_sequences') {
        return mockChain({ data: null, error: null })
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(mkReq(), mkParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ next: 1, series: 'A', fiscal_period_id: 'period-1' })
  })

  it('returns next: null when no fiscal period covers today', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fiscal_periods') {
        return mockChain({ data: null, error: null })
      }
      if (table === 'company_settings') {
        return mockChain({ data: { default_voucher_series: 'V' }, error: null })
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(mkReq(), mkParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ next: null, series: 'V', fiscal_period_id: null })
  })

  it('honors a non-default voucher series from company settings', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fiscal_periods') {
        return mockChain({ data: { id: 'period-2' }, error: null })
      }
      if (table === 'company_settings') {
        return mockChain({ data: { default_voucher_series: 'V' }, error: null })
      }
      if (table === 'voucher_sequences') {
        return mockChain({ data: { last_number: 12 }, error: null })
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(mkReq(), mkParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ next: 13, series: 'V', fiscal_period_id: 'period-2' })
  })

  it('resolves the series per source_type, matching the booking engine', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fiscal_periods') {
        return mockChain({ data: { id: 'period-1' }, error: null })
      }
      if (table === 'company_settings') {
        return mockChain({
          data: {
            default_voucher_series: 'A',
            default_voucher_series_per_source_type: { invoice_cash_payment: 'V' },
          },
          error: null,
        })
      }
      if (table === 'voucher_sequences') {
        return mockChain({ data: { last_number: 4 }, error: null })
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(mkReq('?source_type=invoice_cash_payment'), mkParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    // Uses the per-source-type map (V), NOT the global default (A).
    expect(body.data).toEqual({ next: 5, series: 'V', fiscal_period_id: 'period-1' })
  })

  it('falls back to A when the source_type has no per-source-type mapping', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'fiscal_periods') {
        return mockChain({ data: { id: 'period-1' }, error: null })
      }
      if (table === 'company_settings') {
        return mockChain({
          data: {
            default_voucher_series: 'V',
            default_voucher_series_per_source_type: { invoice_paid: 'B' },
          },
          error: null,
        })
      }
      if (table === 'voucher_sequences') {
        return mockChain({ data: null, error: null })
      }
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await GET(mkReq('?source_type=invoice_cash_payment'), mkParams())
    const body = await response.json()

    expect(response.status).toBe(200)
    // No mapping for invoice_cash_payment → engine-matching fallback of 'A'
    // (the global default is intentionally NOT used here, no consolidation).
    expect(body.data).toEqual({ next: 1, series: 'A', fiscal_period_id: 'period-1' })
  })

  it('rejects an unknown source_type with 400 before touching the database', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const response = await GET(mkReq('?source_type=not_a_source_type'), mkParams())

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects a malformed date with 400 before touching the database', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const response = await GET(mkReq('?date=2026-13-99x'), mkParams())

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects a malformed series with 400 before touching the database', async () => {
    mockAuth.mockResolvedValue({ data: { user: { id: 'user-1' } } })

    const response = await GET(mkReq('?series=AB'), mkParams())

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
