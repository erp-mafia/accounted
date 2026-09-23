import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockCreateJournalEntry = vi.fn()
const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn().mockResolvedValue([
    { account_number: '1930' },
    { account_number: '2099' },
  ]),
}))

// The cascade itself has its own unit tests (lib/import/opening-balance/
// __tests__/cascade.test.ts); here we verify the route wires it correctly:
// flag → original-lines fetch → delta computation → cascade call → response.
const mockCascade = vi.fn()
const mockFetchOriginalLines = vi.fn()
vi.mock('@/lib/import/opening-balance/cascade', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    cascadeOpeningBalanceCorrection: (...args: unknown[]) => mockCascade(...args),
    fetchEntryOpeningBalanceLines: (...args: unknown[]) => mockFetchOriginalLines(...args),
  }
})

import { POST } from '../route'

const PERIOD_ID = '550e8400-e29b-41d4-a716-446655440000'
const CORRECTED_LINES = [
  { account_number: '1930', debit_amount: 40000, credit_amount: 0 },
  { account_number: '2099', debit_amount: 0, credit_amount: 40000 },
]

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/opening-balance/correct', {
    method: 'POST',
    body,
  })
}

const ROUTE_PARAMS = { params: Promise.resolve({}) }

interface CorrectResponse {
  data: {
    success: boolean
    cascade?: {
      corrected: Array<Record<string, unknown>>
      skipped: Array<Record<string, unknown>>
    }
  }
}

function enqueueHappyPath() {
  enqueue({
    data: {
      id: PERIOD_ID,
      company_id: 'company-1',
      is_closed: false,
      locked_at: null,
      opening_balances_set: true,
      opening_balance_entry_id: 'entry-old',
      period_start: '2019-01-01',
      opening_balance_entry: { voucher_series: 'A', voucher_number: 1 },
    },
  }) // period
  enqueue({ data: { bookkeeping_locked_through: null } }) // lock-date pre-flight
  enqueue({ count: 0 }) // year-end check
  enqueue({ error: null }) // relink RPC
}

describe('POST /api/import/opening-balance/correct: cascade wiring', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 9 })
    mockReverseEntry.mockResolvedValue({ id: 'entry-storno' })
    mockFetchOriginalLines.mockResolvedValue([
      { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
      { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
    ])
    mockCascade.mockResolvedValue({
      corrected: [
        {
          fiscal_period_id: 'period-2020',
          period_name: '2020',
          journal_entry_id: 'ib-2020-new',
          reversed_entry_id: 'ib-2020',
        },
      ],
      skipped: [{ fiscal_period_id: 'period-2021', period_name: '2021', reason: 'closed' }],
    })
  })

  it('runs the cascade with the correction deltas and returns its result', async () => {
    enqueueHappyPath()

    const res = await POST(
      makeRequest({ fiscal_period_id: PERIOD_ID, lines: CORRECTED_LINES, cascade: true }),
      ROUTE_PARAMS,
    )
    const { status, body } = await parseJsonResponse<CorrectResponse>(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.cascade).toEqual({
      corrected: [expect.objectContaining({ fiscal_period_id: 'period-2020' })],
      skipped: [expect.objectContaining({ fiscal_period_id: 'period-2021', reason: 'closed' })],
    })

    // Original lines are fetched from the OLD entry (before it is stornoed).
    expect(mockFetchOriginalLines).toHaveBeenCalledWith(expect.anything(), 'company-1', 'entry-old')

    // The cascade gets the base period start and the per-account delta
    // (1930: 40000 - 50000 = -10000, 2099: -40000 - (-50000) = +10000).
    expect(mockCascade).toHaveBeenCalledTimes(1)
    const opts = mockCascade.mock.calls[0][3] as {
      basePeriodStart: string
      deltas: Map<string, number>
      lockDate: string | null
    }
    expect(opts.basePeriodStart).toBe('2019-01-01')
    expect(opts.lockDate).toBeNull()
    expect(opts.deltas.get('1930')).toBe(-10000)
    expect(opts.deltas.get('2099')).toBe(10000)
  })

  it('does not touch later periods when cascade is omitted', async () => {
    enqueueHappyPath()

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: CORRECTED_LINES }), ROUTE_PARAMS)
    const { status, body } = await parseJsonResponse<CorrectResponse>(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.cascade).toBeUndefined()
    expect(mockFetchOriginalLines).not.toHaveBeenCalled()
    expect(mockCascade).not.toHaveBeenCalled()
  })

  it('still returns success for the base correction when the cascade throws unexpectedly', async () => {
    enqueueHappyPath()
    mockCascade.mockRejectedValue(new Error('cascade boom'))

    const res = await POST(
      makeRequest({ fiscal_period_id: PERIOD_ID, lines: CORRECTED_LINES, cascade: true }),
      ROUTE_PARAMS,
    )
    const { status, body } = await parseJsonResponse<CorrectResponse>(res)

    // The base correction is already committed; the response must not flip to
    // an error the caller would retry (double-correcting the base year), but
    // the failure must be visible so the client can tell the user to check.
    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.cascade).toEqual({ corrected: [], skipped: [], failed: true })
  })
})
