/**
 * The v1 voucher doors (POST /journal-entries and /journal-entries/batch-create)
 * take source_id only as a UUID: journal_entries.source_id is a uuid column,
 * so a free-form reference from another system ("<provider>:<date>") reached
 * the insert and answered 500 BOOKKEEPING_DATABASE_ERROR ("invalid input
 * syntax for type uuid"). It is a 400 naming the field now, before the engine.
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
  ownsFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, createDraftEntry: vi.fn() }
})

import { createTableMockSupabase } from '@/tests/helpers'
import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ownsFiscalPeriod } from '@/lib/api/v1/owns-fiscal-period'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { POST as createDraft } from '../route'
import { POST as batchCreate } from '../batch-create/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockOwnsPeriod = ownsFiscalPeriod as ReturnType<typeof vi.fn>
const mockCreateDraft = createDraftEntry as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FISCAL_PERIOD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SOURCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/**
 * company_members proves the key may touch this company; every other read
 * (idempotency store, the post-create refetch) answers null.
 */
function makeSupabase() {
  return createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' } },
  }).supabase
}

const ENTRY = {
  fiscal_period_id: FISCAL_PERIOD_ID,
  entry_date: '2026-11-08',
  description: 'Dagskassa',
  source_type: 'pos_daily_sales',
  lines: [
    { account_number: '1580', debit_amount: 100, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 80 },
    { account_number: '2611', debit_amount: 0, credit_amount: 20 },
  ],
}

function makeRequest(path: string, body: unknown, { auth = true } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': `idem${Math.floor(Math.random() * 1e6)}-1110-4abc-8def-1234567890ab`,
  }
  if (auth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(`http://localhost/api/v1/companies/${COMPANY_ID}/journal-entries${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

type ErrorBody = { error: { code: string; details?: { issues?: Array<{ field: string; message: string }> } } }

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
  mockOwnsPeriod.mockResolvedValue(true)
  mockCreateDraft.mockResolvedValue({ id: 'je-1', status: 'draft', voucher_series: 'F', voucher_number: 0 })
})

describe('POST /api/v1/companies/:companyId/journal-entries: source_id', () => {
  it('returns 401 without an API key', async () => {
    const res = await createDraft(makeRequest('', { ...ENTRY, source_id: SOURCE_ID }, { auth: false }), routeParams)
    expect(res.status).toBe(401)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it.each(['kassa:2026-11-08', 'not-a-uuid', '12345', `${SOURCE_ID}x`])(
    'refuses the non-UUID source_id %s with 400 naming the field, before the engine',
    async (sourceId) => {
      const res = await createDraft(makeRequest('', { ...ENTRY, source_id: sourceId }), routeParams)
      const body = (await res.json()) as ErrorBody

      expect(res.status).toBe(400)
      expect(body.error.code).toBe('VALIDATION_ERROR')
      const issue = body.error.details?.issues?.find((i) => i.field === 'source_id')
      expect(issue?.message).toContain('source_id måste vara ett UUID')
      expect(issue?.message).toContain('description eller notes')
      expect(mockCreateDraft).not.toHaveBeenCalled()
    },
  )

  it('refuses a non-string source_id with the same 400', async () => {
    const res = await createDraft(makeRequest('', { ...ENTRY, source_id: 20261108 }), routeParams)
    const body = (await res.json()) as ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.details?.issues?.find((i) => i.field === 'source_id')?.message).toContain('UUID')
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('returns 404 when the fiscal period is not the company\'s', async () => {
    mockOwnsPeriod.mockResolvedValue(false)
    const res = await createDraft(makeRequest('', { ...ENTRY, source_id: SOURCE_ID }), routeParams)

    expect(res.status).toBe(404)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('creates the draft with a UUID source_id unchanged', async () => {
    const res = await createDraft(makeRequest('', { ...ENTRY, source_id: SOURCE_ID }), routeParams)

    expect(res.status).toBe(201)
    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ source_type: 'pos_daily_sales', source_id: SOURCE_ID }),
    )
  })

  it('accepts an upper-case UUID and one outside the RFC version layout, as the uuid column does', async () => {
    for (const sourceId of [SOURCE_ID.toUpperCase(), '00000000-0000-0000-0000-000000000001']) {
      const res = await createDraft(makeRequest('', { ...ENTRY, source_id: sourceId }), routeParams)
      expect(res.status).toBe(201)
    }
    expect(mockCreateDraft).toHaveBeenCalledTimes(2)
  })

  it('keeps accepting an omitted or empty source_id', async () => {
    const omitted = await createDraft(makeRequest('', ENTRY), routeParams)
    const empty = await createDraft(makeRequest('', { ...ENTRY, source_id: '' }), routeParams)

    expect(omitted.status).toBe(201)
    expect(empty.status).toBe(201)
    expect(mockCreateDraft).toHaveBeenCalledTimes(2)
  })
})

describe('POST /api/v1/companies/:companyId/journal-entries/batch-create: source_id', () => {
  it('returns 401 without an API key', async () => {
    const res = await batchCreate(
      makeRequest('/batch-create', { journal_entries: [ENTRY] }, { auth: false }),
      routeParams,
    )
    expect(res.status).toBe(401)
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses the whole batch with 400 when an item carries a non-UUID source_id', async () => {
    const res = await batchCreate(
      makeRequest('/batch-create', {
        journal_entries: [{ ...ENTRY, source_id: SOURCE_ID }, { ...ENTRY, source_id: 'kassa:2026-11-08' }],
      }),
      routeParams,
    )
    const body = (await res.json()) as ErrorBody

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    const issue = body.error.details?.issues?.find((i) => i.field === 'journal_entries.1.source_id')
    expect(issue?.message).toContain('source_id måste vara ett UUID')
    expect(mockCreateDraft).not.toHaveBeenCalled()
  })

  it('creates drafts that carry a UUID source_id', async () => {
    const res = await batchCreate(
      makeRequest('/batch-create', { journal_entries: [{ ...ENTRY, source_id: SOURCE_ID }, ENTRY] }),
      routeParams,
    )
    const body = (await res.json()) as { data: { summary: { succeeded: number } } }

    expect(res.status).toBe(200)
    expect(body.data.summary.succeeded).toBe(2)
    expect(mockCreateDraft.mock.calls.map((call) => (call[3] as { source_id?: string }).source_id)).toEqual([
      SOURCE_ID,
      undefined,
    ])
  })
})
