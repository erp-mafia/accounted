import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockCreateClient(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

const mockGetCompanyEntityType = vi.fn()
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyEntityType: (...args: unknown[]) => mockGetCompanyEntityType(...args),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockBuildAccrualsProposal = vi.fn()
const mockDetectPeriodisering = vi.fn()
vi.mock('@/lib/bokslut/accruals/accrual-detector', async () => {
  const actual =
    (await vi.importActual('@/lib/bokslut/accruals/accrual-detector')) as Record<string, unknown>
  return {
    ...actual,
    buildAccrualsProposal: (...args: unknown[]) => mockBuildAccrualsProposal(...args),
  }
})

vi.mock('@/lib/bokslut/accruals/auto-detect', () => ({
  detectPeriodisering: (...args: unknown[]) => mockDetectPeriodisering(...args),
}))

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = (await vi.importActual('@/lib/bookkeeping/engine')) as Record<string, unknown>
  return {
    ...actual,
    createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  }
})

const mockUser = { id: 'user-1', email: 'test@test.se' }

// The route module pulls in the bookkeeping engine and accrual detector; that
// parse can take seconds under full-suite parallel load. Warm it once here so
// no individual test's default 5s timeout has to absorb the import cost.
let GET: typeof import('../route').GET
let POST: typeof import('../route').POST
beforeAll(async () => {
  ;({ GET, POST } = await import('../route'))
}, 30_000)

/** Minimal supabase mock: auth only. The entity_type resolution is mocked at
 *  the getCompanyEntityType boundary (company_settings-primary with a
 *  companies fallback lives inside lib/company/context, tested there). */
function mockSupabase() {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateClient.mockResolvedValue(mockSupabase())
  mockGetCompanyEntityType.mockResolvedValue('aktiebolag')
})

describe('GET /api/bookkeeping/fiscal-periods/[id]/accruals', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    })
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    expect(res.status).toBe(401)
  })

  it('returns the snapshot plus autoDetected suggestions', async () => {
    mockBuildAccrualsProposal.mockResolvedValue({
      notices: [],
      fiscalPeriod: { id: 'period-1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      proposals: [],
    })
    mockDetectPeriodisering.mockResolvedValue([
      {
        source_invoice_id: 'sup-1',
        source_type: 'supplier_invoice',
        original_amount: 12000,
        periodisering_amount: 6000,
        parsed_start: '2025-07-01',
        parsed_end: '2026-06-30',
        confidence: 'high',
        reason: 'Mock reason',
        source_label: 'Test Supplier',
        suggested_prepaid_account: '1710',
        suggested_deferred_account: null,
      },
    ])
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { autoDetected: unknown[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.autoDetected).toHaveLength(1)
    // The route resolves the company's entity_type and threads it through so
    // the materiality wording cites the right regelverk (K1 vs K2).
    expect(mockDetectPeriodisering).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      { entityType: 'aktiebolag' },
    )
  })

  it('threads entity_type enskild_firma to the detector', async () => {
    mockGetCompanyEntityType.mockResolvedValue('enskild_firma')
    mockBuildAccrualsProposal.mockResolvedValue({
      notices: [],
      fiscalPeriod: { id: 'period-1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      proposals: [],
    })
    mockDetectPeriodisering.mockResolvedValue([])
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    expect(res.status).toBe(200)
    expect(mockDetectPeriodisering).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      { entityType: 'enskild_firma' },
    )
  })

  it('falls back to null entityType when the entity type cannot be resolved', async () => {
    mockGetCompanyEntityType.mockResolvedValue(null)
    mockBuildAccrualsProposal.mockResolvedValue({
      notices: [],
      fiscalPeriod: { id: 'period-1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      proposals: [],
    })
    mockDetectPeriodisering.mockResolvedValue([])
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    expect(res.status).toBe(200)
    expect(mockDetectPeriodisering).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      { entityType: null },
    )
  })

  it('still returns the snapshot when auto-detect throws', async () => {
    mockBuildAccrualsProposal.mockResolvedValue({
      notices: [],
      fiscalPeriod: { id: 'period-1', name: 'FY 2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      proposals: [],
    })
    mockDetectPeriodisering.mockRejectedValue(new Error('boom'))
    const res = await GET(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals'),
      createMockRouteParams({ id: 'period-1' }),
    )
    const { status, body } = await parseJsonResponse<{ data: { autoDetected: unknown[] } }>(res)
    expect(status).toBe(200)
    expect(body.data.autoDetected).toEqual([])
  })
})

describe('POST /api/bookkeeping/fiscal-periods/[id]/accruals', () => {
  const OPEN_PERIOD = {
    id: 'period-1',
    name: 'FY 2025',
    period_end: '2025-12-31',
    is_closed: false,
    closing_entry_id: null,
    locked_at: null,
  }

  /** fiscal_periods answers the period; journal_entries (the idempotency
   *  lookup) answers no earlier accrual. */
  function mockSupabaseForPost(period: Record<string, unknown> | null) {
    const periodChain: Record<string, unknown> = {}
    periodChain.select = () => periodChain
    periodChain.eq = () => periodChain
    periodChain.single = () =>
      Promise.resolve({ data: period, error: period ? null : { message: 'not found' } })
    const entriesChain: Record<string, unknown> = {}
    entriesChain.select = () => entriesChain
    entriesChain.eq = () => entriesChain
    entriesChain.ilike = () => entriesChain
    entriesChain.limit = () => Promise.resolve({ data: [], error: null })
    return {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: mockUser } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
      from: vi.fn((table: string) => (table === 'fiscal_periods' ? periodChain : entriesChain)),
    }
  }

  const post = (body: unknown) =>
    POST(
      createMockRequest('/api/bookkeeping/fiscal-periods/period-1/accruals', { method: 'POST', body }),
      createMockRouteParams({ id: 'period-1' }),
    )

  const accrued = {
    kind: 'manual_accrued_expense',
    amount: 5000,
    expense_account: '5010',
    accrued_account: '2990',
    description: 'Hyra december',
  }

  beforeEach(() => {
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
  })

  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }), mfa: { listFactors: async () => ({ data: { all: [], totp: [], phone: [] }, error: null }) } },
    })
    const res = await post({ items: [accrued] })
    expect(res.status).toBe(401)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects a malformed dimensions bag with 400 before anything is posted', async () => {
    mockCreateClient.mockResolvedValue(mockSupabaseForPost(OPEN_PERIOD))
    const res = await post({ items: [{ ...accrued, dimensions: { projekt: 'P001' } }] })
    expect(res.status).toBe(400)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 404 for a period outside the company', async () => {
    mockCreateClient.mockResolvedValue(mockSupabaseForPost(null))
    const res = await post({ items: [{ ...accrued, dimensions: { '6': 'P001' } }] })
    expect(res.status).toBe(404)
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('tags the result leg of a manual accrual with its dimensions and leaves the interim leg untagged', async () => {
    mockCreateClient.mockResolvedValue(mockSupabaseForPost(OPEN_PERIOD))
    const res = await post({
      items: [
        { ...accrued, dimensions: { '1': 'KS01', '6': 'P001' } },
        {
          kind: 'manual_prepaid_expense',
          amount: 12000,
          expense_account: '6310',
          prepaid_account: '1730',
          description: 'Försäkring 2026',
        },
      ],
    })

    expect(res.status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(2)
    const linesOf = (call: number) =>
      (mockCreateJournalEntry.mock.calls[call][3] as {
        lines: Array<{ account_number: string; dimensions?: Record<string, string> }>
      }).lines.map((l) => [l.account_number, l.dimensions])
    expect(linesOf(0)).toEqual([
      ['5010', { '1': 'KS01', '6': 'P001' }],
      ['2990', undefined],
    ])
    // No bag sent: the proposal's lines post exactly as before.
    expect(linesOf(1)).toEqual([
      ['1730', undefined],
      ['6310', undefined],
    ])
  })
})
