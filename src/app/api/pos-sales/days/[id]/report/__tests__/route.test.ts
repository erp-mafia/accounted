import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset, enqueue } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const render = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pos-sales/day-report-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pos-sales/day-report-pdf')>()),
  renderPosDayReport: render,
}))

import { GET } from '../route'

const ID = '550e8400-e29b-41d4-a716-446655440000'
const PARAMS = { params: Promise.resolve({ id: ID }) }

const DAY_ROW = {
  id: ID,
  company_id: 'company-1',
  connection_id: 'conn-1',
  business_date: '2026-09-30',
  gross: '112.00',
  net: '100.00',
  vat: '12.00',
  tips: '0.00',
  raw_sha256: 'a'.repeat(64),
  fetched_at: '2026-10-01T04:15:00Z',
  journal_entry_id: null,
  review_reasons: [],
  tenders: [],
  vat_groups: [],
  day: {
    businessDate: '2026-09-30',
    currency: 'SEK',
    sales: { net: 100, vat: 12, gross: 112 },
    vatGroups: [{ ratePercent: 12, net: 100, vat: 12, gross: 112 }],
    tenders: [{ kind: 'card', method: 'card', amount: 112, tips: 0, receiptCount: 1 }],
    tips: 0,
    discounts: 0,
    refunds: { count: 0, gross: 0 },
    receiptCount: 1,
    firstReceiptNumber: '1',
    lastReceiptNumber: '1',
    firstPaidAt: null,
    lastPaidAt: null,
    categories: [],
    receipts: [],
    issues: [],
  },
}

describe('GET /api/pos-sales/days/:id/report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    render.mockResolvedValue(Buffer.from('%PDF-1.4 test'))
  })

  it('answers 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await GET(createMockRequest(`/api/pos-sales/days/${ID}/report`), PARAMS)).status).toBe(401)
    expect(render).not.toHaveBeenCalled()
  })

  it('answers 404 for a day the company does not have', async () => {
    enqueue({ data: null, error: null })
    const { status } = await parseJsonResponse(await GET(createMockRequest(`/api/pos-sales/days/${ID}/report`), PARAMS))
    expect(status).toBe(404)
  })

  it('renders the unbooked day with the proposal lines, inline', async () => {
    enqueue({ data: DAY_ROW, error: null })
    enqueue({ data: { venue_name: 'Café Exempel', provider_name: 'Heynow', settings: {} }, error: null })
    enqueue({ data: { company_name: 'Exempel AB', org_number: '556677-8899' }, error: null })
    const response = await GET(createMockRequest(`/api/pos-sales/days/${ID}/report`), PARAMS)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''Dagsrapport_kassa_Caf%C3%A9_Exempel_2026-09-30.pdf")
    const input = render.mock.calls[0][0]
    expect(input.lines.map((l: { account_number: string }) => l.account_number)).toEqual(['1686', '3002', '2621'])
    expect(input.voucherLabel).toBeNull()
  })
})
