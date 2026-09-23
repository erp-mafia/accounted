/**
 * POST /api/v1/companies/:companyId/journal-entries?dry_run=true resolves the
 * lines' accounts against the chart, so a dry run fails with
 * ACCOUNTS_NOT_IN_CHART for the same accounts the live call would reject
 * (#2516). Before, the dry-run branch returned a clean preview and the error
 * only surfaced on the live call.
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
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockFindUnresolvable = findUnresolvableAccounts as ReturnType<typeof vi.fn>
const mockCreateDraft = createDraftEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FISCAL_PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/**
 * company_members proves the key may touch this company; every other single-row
 * read (the idempotency store) answers null so the request is not a replay.
 */
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

const BODY = {
  fiscal_period_id: FISCAL_PERIOD_ID,
  entry_date: '2026-05-12',
  description: 'Bankavgift maj 2026',
  lines: [
    { account_number: '6570', debit_amount: 50, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 50 },
  ],
}

function makeRequest(body: unknown, { auth = true, dryRun = true } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1010-4abc-8def-1234567890ab`,
  }
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(
    `http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries${dryRun ? '?dry_run=true' : ''}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  )
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

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
})

describe('POST /api/v1/companies/:companyId/journal-entries (dry run)', () => {
  it('returns 401 without an API key', async () => {
    const res = await POST(makeRequest(BODY, { auth: false }), routeParams)
    expect(res.status).toBe(401)
    expect(mockFindUnresolvable).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body before resolving any account', async () => {
    const res = await POST(makeRequest({ ...BODY, lines: [BODY.lines[0]] }), routeParams)
    expect(res.status).toBe(400)
    expect(mockFindUnresolvable).not.toHaveBeenCalled()
  })

  it('fails with ACCOUNTS_NOT_IN_CHART for a deactivated or unknown account, without creating a draft', async () => {
    mockFindUnresolvable.mockResolvedValue(['6570'])

    const res = await POST(makeRequest(BODY), routeParams)
    const body = (await res.json()) as { error: { code: string; details: Record<string, unknown> } }

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.details).toMatchObject({ account_numbers: ['6570'] })
    expect(mockFindUnresolvable).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ['6570', '1930'])
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('previews the draft when every account resolves (a standard BAS account the engine would seed passes)', async () => {
    // findUnresolvableAccounts already lets a BAS account with no chart row
    // through; the route only has to trust an empty answer.
    const res = await POST(makeRequest(BODY), routeParams)
    const body = (await res.json()) as { data: { dry_run: boolean; preview: { lines: unknown[] } } }

    expect(res.status).toBe(200)
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.lines).toHaveLength(2)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })
})
