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

const mockBackfill = vi.fn().mockResolvedValue([])
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => mockBackfill(...args),
}))

// The cascade has its own unit tests; here we verify the route wires it with
// mode 'inline' and the delta computed from struck vs new lines.
const mockCascade = vi.fn()
vi.mock('@/lib/import/opening-balance/cascade', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    cascadeOpeningBalanceCorrection: (...args: unknown[]) => mockCascade(...args),
  }
})

import { POST } from '../route'

const PERIOD_ID = '550e8400-e29b-41d4-a716-446655440000'
const LINE_1930 = '11111111-1111-4111-8111-111111111111'
const ROUTE_PARAMS = { params: Promise.resolve({}) }

interface InlineResponse {
  data: {
    success: boolean
    journal_entry_id: string
    cascade?: { corrected: unknown[]; skipped: unknown[] }
  }
  error?: { code: string; message?: string }
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/opening-balance/correct-inline', {
    method: 'POST',
    body,
  })
}

function openPeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: PERIOD_ID,
    period_start: '2024-01-01',
    is_closed: false,
    locked_at: null,
    opening_balances_set: true,
    opening_balance_entry_id: 'entry-ib',
    ...overrides,
  }
}

const BODY = {
  fiscal_period_id: PERIOD_ID,
  strike_line_ids: [LINE_1930],
  new_lines: [{ account_number: '1930', debit_amount: 55000, credit_amount: 0 }],
  cascade: true,
}

describe('POST /api/import/opening-balance/correct-inline', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockCascade.mockResolvedValue({ corrected: [], skipped: [] })
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest(BODY), ROUTE_PARAMS)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 when nothing is struck or added', async () => {
    const res = await POST(
      makeRequest({ fiscal_period_id: PERIOD_ID, strike_line_ids: [], new_lines: [] }),
      ROUTE_PARAMS,
    )
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 for an unknown fiscal period', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const res = await POST(makeRequest(BODY), ROUTE_PARAMS)
    const { status, body } = await parseJsonResponse<InlineResponse>(res)

    expect(status).toBe(404)
    expect(body.error?.code).toBe('OB_PERIOD_NOT_FOUND')
  })

  it('refuses closed periods with the same code as the storno route', async () => {
    enqueue({ data: openPeriod({ is_closed: true }) })

    const res = await POST(makeRequest(BODY), ROUTE_PARAMS)
    const { status, body } = await parseJsonResponse<InlineResponse>(res)

    expect(status).toBe(400)
    expect(body.error?.code).toBe('OB_PERIOD_CLOSED')
  })

  it('refuses periods with a posted bokslut', async () => {
    enqueue({ data: openPeriod() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // lock date
    enqueue({ count: 1 }) // year-end check

    const res = await POST(makeRequest(BODY), ROUTE_PARAMS)
    const { status, body } = await parseJsonResponse<InlineResponse>(res)

    expect(status).toBe(409)
    expect(body.error?.code).toBe('OB_CORRECT_YEAR_END_EXISTS')
  })

  it('edits in place via the RPC and cascades inline with the struck-vs-new delta', async () => {
    enqueue({ data: openPeriod() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // lock date
    enqueue({ count: 0 }) // year-end check
    enqueue({
      data: [
        { id: LINE_1930, account_number: '1930', debit_amount: 50000, credit_amount: 0 },
      ],
    }) // struck lines fetch
    enqueue({ data: { log_id: 'log-1', struck_count: 1, added_count: 1 } }) // RPC

    const res = await POST(makeRequest(BODY), ROUTE_PARAMS)
    const { status, body } = await parseJsonResponse<InlineResponse>(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.journal_entry_id).toBe('entry-ib')
    expect(body.data.cascade).toEqual({ corrected: [], skipped: [] })

    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'correct_entry_lines_inline',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_entry_id: 'entry-ib',
        p_strike_line_ids: [LINE_1930],
        p_new_lines: [
          expect.objectContaining({ account_number: '1930', debit_amount: 55000 }),
        ],
        p_user_id: 'user-1',
      }),
    )

    // Cascade runs in inline mode with delta = new (55000) minus struck (50000).
    expect(mockCascade).toHaveBeenCalledTimes(1)
    const opts = mockCascade.mock.calls[0][3] as {
      basePeriodStart: string
      mode: string
      deltas: Map<string, number>
    }
    expect(opts.mode).toBe('inline')
    expect(opts.basePeriodStart).toBe('2024-01-01')
    expect(opts.deltas.get('1930')).toBe(5000)
  })

  it('does not cascade when the flag is omitted', async () => {
    enqueue({ data: openPeriod() })
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ count: 0 })
    enqueue({ data: [{ id: LINE_1930, account_number: '1930', debit_amount: 50000, credit_amount: 0 }] })
    enqueue({ data: { log_id: 'log-1' } }) // RPC

    const res = await POST(
      makeRequest({ ...BODY, cascade: undefined }),
      ROUTE_PARAMS,
    )
    const { status, body } = await parseJsonResponse<InlineResponse>(res)

    expect(status).toBe(200)
    expect(body.data.cascade).toBeUndefined()
    expect(mockCascade).not.toHaveBeenCalled()
  })

  it('surfaces an RPC rule violation verbatim as 409 OB_INLINE_REFUSED', async () => {
    enqueue({ data: openPeriod() })
    enqueue({ data: { bookkeeping_locked_through: null } })
    enqueue({ count: 0 })
    enqueue({ data: [{ id: LINE_1930, account_number: '1930', debit_amount: 50000, credit_amount: 0 }] })
    enqueue({ data: null, error: { code: 'P0001', message: 'Verifikationen balanserar inte efter rättelsen (debet 55000, kredit 50000).' } })

    const res = await POST(makeRequest(BODY), ROUTE_PARAMS)
    const { status, body } = await parseJsonResponse<InlineResponse>(res)

    expect(status).toBe(409)
    expect(body.error?.code).toBe('OB_INLINE_REFUSED')
    expect(body.error?.message).toContain('balanserar inte')
    expect(mockCascade).not.toHaveBeenCalled()
  })
})
