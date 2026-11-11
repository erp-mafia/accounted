import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { PatternExpectation } from '@/lib/inkorg/expectations'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-16',
}))
const loadMock = vi.fn()
vi.mock('@/lib/inkorg/expectations-read', () => ({
  loadExpectations: (...args: unknown[]) => loadMock(...args),
}))
const openMock = vi.fn()
vi.mock('@/lib/receipt-hunt/purchases-without-underlag', () => ({
  fetchPurchasesWithoutUnderlag: (...args: unknown[]) => openMock(...args),
}))
const logosMock = vi.fn()
vi.mock('@/lib/vendor-logos/read', () => ({
  vendorLogoUrls: (...args: unknown[]) => logosMock(...args),
}))

import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function request() {
  return new Request('http://localhost/api/inkorg/expectations')
}

/** A monthly subscription whose receipts come to the intake address the day after the bank row. */
function subscription(overrides: Partial<PatternExpectation> = {}): PatternExpectation {
  return {
    key: 'bank:molntjansten',
    kind: 'bank',
    name: 'MOLNTJANSTEN',
    supplierId: null,
    bankKeys: ['molntjansten'],
    fit: { cadence: 'monthly', months: 1, days: 30.44, windowDays: 3, weak: false },
    occurrences: [],
    events: 6,
    lastSeen: '2026-10-15',
    next: { expected: '2026-11-15', from: '2026-11-12', to: '2026-11-18' },
    amount: { usual: 699, min: 699, max: 699 },
    door: 'intake_email',
    portal: null,
    waitDays: 3,
    ...overrides,
  }
}

const OPEN = {
  id: 'tx-open',
  company_id: 'company-1',
  date: '2026-10-15',
  description: 'MOLNTJANSTEN',
  merchant_name: null,
  amount: -699,
  currency: 'SEK',
  amount_sek: -699,
  exchange_rate: null,
  journal_entry_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  loadMock.mockResolvedValue([])
  openMock.mockResolvedValue([])
  logosMock.mockResolvedValue(new Map())
})

describe('GET /api/inkorg/expectations', () => {
  it('returns 401 when not signed in, and reads nothing', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(request(), createMockRouteParams({}))
    expect(res.status).toBe(401)
    expect(loadMock).not.toHaveBeenCalled()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('answers the expectations due within 45 days and the purchases on their way', async () => {
    const yearly = subscription({
      key: 'bank:domanregistret',
      name: 'DOMANREGISTRET',
      bankKeys: ['domanregistret'],
      fit: { cadence: 'yearly', months: 12, days: 365.25, windowDays: 3, weak: true },
      next: { expected: '2027-09-30', from: '2027-09-27', to: '2027-10-03' },
    })
    loadMock.mockResolvedValue([subscription(), yearly])
    openMock.mockResolvedValue([OPEN, { ...OPEN, id: 'tx-other', description: 'BYGGHANDELN' }])

    const res = await GET(request(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)
    expect(status).toBe(200)
    expect(loadMock).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-10-16')
    expect(openMock).toHaveBeenCalledWith(mockSupabase, 'company-1')
    expect(body.data).toEqual({
      horizon_days: 45,
      expectations: [
        {
          key: 'bank:molntjansten',
          counterparty: 'MOLNTJANSTEN',
          supplier_id: null,
          cadence: 'monthly',
          expected_on: '2026-11-15',
          window_from: '2026-11-12',
          window_to: '2026-11-18',
          amount: { usual: 699, min: 699, max: 699 },
          door: 'intake_email',
          portal: null,
          last_seen: '2026-10-15',
          occurrences: 6,
          logo_url: null,
        },
      ],
      on_the_way: [
        {
          transaction_id: 'tx-open',
          expectation_key: 'bank:molntjansten',
          counterparty: 'MOLNTJANSTEN',
          door: 'intake_email',
          expected_by: '2026-10-18',
        },
      ],
    })
  })

  it("carries the vendor's stored icon, looked up by the expectation's counterpart", async () => {
    loadMock.mockResolvedValue([subscription()])
    logosMock.mockResolvedValue(new Map([['bank:molntjansten', 'https://storage.example/logos/ab12.png']]))

    const res = await GET(request(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { expectations: Array<{ key: string; logo_url: string | null }> } }>(res)
    expect(status).toBe(200)
    expect(logosMock).toHaveBeenCalledWith([{ key: 'bank:molntjansten', name: 'MOLNTJANSTEN' }])
    expect(body.data.expectations[0]?.logo_url).toBe('https://storage.example/logos/ab12.png')
  })

  it('answers empty lists for a company with no regular suppliers', async () => {
    openMock.mockResolvedValue([OPEN])
    const res = await GET(request(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { expectations: unknown[]; on_the_way: unknown[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.expectations).toEqual([])
    expect(body.data.on_the_way).toEqual([])
  })

  it('answers the error envelope when a read fails', async () => {
    loadMock.mockRejectedValue(new Error('statement timeout'))
    const res = await GET(request(), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(500)
    expect(typeof body.error.code).toBe('string')
  })
})
