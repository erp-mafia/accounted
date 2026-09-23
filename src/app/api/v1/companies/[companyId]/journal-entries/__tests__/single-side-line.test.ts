/**
 * POST /api/v1/companies/:companyId/journal-entries refuses a line carrying
 * both debit and credit above zero (#2551).
 *
 * Such a line cancels itself, so the totals-only balance pre-check sees a
 * balanced entry and lets it through: before the shared `isSingleSidedLine`
 * refinement landed on CreateJournalEntryLineSchema, the nollverifikat posted
 * and storno could never undo it. The refinement turns it into a 400
 * VALIDATION_ERROR naming the offending line, before the engine or the
 * database is touched. This is the surface agents and the MCP tools post
 * through, so it is where the rule has to hold.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/api/v1/owns-fiscal-period', () => ({
  ownsFiscalPeriod: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/bookkeeping/account-validation', () => ({
  findUnresolvableAccounts: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createDraftEntry: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockFindUnresolvable = findUnresolvableAccounts as ReturnType<typeof vi.fn>
const mockCreateDraft = createDraftEntry as ReturnType<typeof vi.fn>
const mockOwnsFiscalPeriod = ownsFiscalPeriod as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FISCAL_PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const BOTH_SIDES_MESSAGE = 'En verifikationsrad kan inte ha både debet och kredit nollskilda.'

function makeSupabase() {
  const build = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          const row = table === 'company_members'
            ? { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' }
            : null
          return () => Promise.resolve({ data: row, error: null })
        }
        return () => build(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => build(table)) }
}

function makeBody(lines: Array<Record<string, unknown>>) {
  return {
    fiscal_period_id: FISCAL_PERIOD_ID,
    entry_date: '2026-05-12',
    description: 'Bankavgift maj 2026',
    lines,
  }
}

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1010-4abc-8def-1234567890ab`,
    },
    body: JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

interface V1ErrorBody {
  error: {
    code: string
    message: string
    details?: { issues?: Array<{ field: string; message: string }> }
    request_id?: string
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase())
  mockFindUnresolvable.mockResolvedValue([])
  mockOwnsFiscalPeriod.mockResolvedValue(true)
})

describe('POST /api/v1/companies/:companyId/journal-entries: single-side line rule (#2551)', () => {
  it('returns 400 VALIDATION_ERROR naming the offending line, and never reaches the engine', async () => {
    const res = await POST(
      makeRequest(
        makeBody([
          { account_number: '1930', debit_amount: 100, credit_amount: 100 },
          { account_number: '1930', debit_amount: 50, credit_amount: 0 },
          { account_number: '6570', debit_amount: 0, credit_amount: 50 },
        ]),
      ),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.issues).toContainEqual({
      field: 'lines.0',
      message: BOTH_SIDES_MESSAGE,
    })
    // Nothing downstream ran: not the ownership read, not the account
    // resolution, not the engine.
    expect(mockOwnsFiscalPeriod).not.toHaveBeenCalled()
    expect(mockFindUnresolvable).not.toHaveBeenCalled()
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('rejects both sides even when they do not cancel each other out', async () => {
    const res = await POST(
      makeRequest(
        makeBody([
          { account_number: '6570', debit_amount: 50, credit_amount: 20 },
          { account_number: '1930', debit_amount: 0, credit_amount: 30 },
        ]),
      ),
      routeParams,
    )
    const body = (await res.json()) as V1ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details?.issues?.some((i) => i.message === BOTH_SIDES_MESSAGE)).toBe(true)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('still creates the draft for one-sided lines', async () => {
    mockCreateDraft.mockResolvedValue({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      status: 'draft',
      voucher_series: 'A',
      voucher_number: 0,
    })

    const res = await POST(
      makeRequest(
        makeBody([
          { account_number: '6570', debit_amount: 50, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 50 },
        ]),
      ),
      routeParams,
    )

    expect(res.status).toBe(201)
    expect(mockCreateDraft).toHaveBeenCalledTimes(1)
  })
})
