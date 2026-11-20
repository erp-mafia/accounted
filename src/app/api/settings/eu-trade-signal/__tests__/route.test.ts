/**
 * Tests for /api/settings/eu-trade-signal: ledger-derived EU trade signal,
 * read from the declaration's own rutor (loadVatDeclarationLedger).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const loadLedgerMock = vi.fn()
vi.mock('@/lib/reports/vat-declaration', () => ({
  loadVatDeclarationLedger: (...args: unknown[]) => loadLedgerMock(...args),
}))

const EMPTY_RUTOR = {
  ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0, ruta10: 0, ruta11: 0, ruta12: 0,
  ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0, ruta30: 0, ruta31: 0, ruta32: 0,
  ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0, ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
  ruta48: 0, ruta49: 0, ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
}

type SignalBody = {
  data: {
    has_eu_sales: boolean
    has_eu_purchases: boolean
    eu_trade_rutor: Array<{ ruta: string; amount: number }>
  }
}

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/settings/eu-trade-signal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/settings/eu-trade-signal'), { params: Promise.resolve({}) })
    expect(res.status).toBe(401)
  })

  it('reports EU sales from rutor 35/38/39', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
    loadLedgerMock.mockResolvedValue({ rutor: { ...EMPTY_RUTOR, ruta39: 1200 } })

    const { status, body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/eu-trade-signal'), { params: Promise.resolve({}) })
    )
    expect(status).toBe(200)
    expect(body.data.has_eu_sales).toBe(true)
    expect(body.data.has_eu_purchases).toBe(false)
    expect(body.data.eu_trade_rutor).toEqual([{ ruta: '39', amount: 1200 }])
    // Scoped to the active company, from 15 months back to today.
    const [, companyId, since, until] = loadLedgerMock.mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(since < until).toBe(true)
  })

  it('reports EU purchases from rutor 20/21/37, and not purchases outside the EU (ruta 22) (crm#1171)', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
    loadLedgerMock.mockResolvedValue({ rutor: { ...EMPTY_RUTOR, ruta21: 448.41, ruta22: 16061.04 } })

    const { status, body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/eu-trade-signal'), { params: Promise.resolve({}) })
    )
    expect(status).toBe(200)
    expect(body.data.has_eu_purchases).toBe(true)
    expect(body.data.has_eu_sales).toBe(false)
    expect(body.data.eu_trade_rutor).toEqual([{ ruta: '21', amount: 448.41 }])
  })

  it('reports no EU trade when only non-EU boxes carry amounts', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
    loadLedgerMock.mockResolvedValue({ rutor: { ...EMPTY_RUTOR, ruta22: 500, ruta36: 900 } })

    const { status, body } = await parseJsonResponse<SignalBody>(
      await GET(createMockRequest('/api/settings/eu-trade-signal'), { params: Promise.resolve({}) })
    )
    expect(status).toBe(200)
    expect(body.data.has_eu_sales).toBe(false)
    expect(body.data.has_eu_purchases).toBe(false)
    expect(body.data.eu_trade_rutor).toEqual([])
  })
})
