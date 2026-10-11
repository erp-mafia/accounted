/**
 * Integration tests for POST /api/v1/companies/:companyId/transactions/ingest
 * and POST .../batch-categorize.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
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

const { ingestMock, createTxJE, findMissingAccountsMock } = vi.hoisted(() => ({
  ingestMock: vi.fn().mockResolvedValue({
    imported: 2,
    duplicates: 1,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  }),
  createTxJE: vi.fn().mockResolvedValue({ id: 'je-bc' }),
  // batch-categorize pre-validates every mapped account against chart_of_accounts
  // (commit 6afb13aa). The flexible-Supabase proxy returns { data: null } for
  // unmocked tables, which would make the real implementation report ALL
  // accounts as missing and short-circuit every item with ACCOUNTS_NOT_IN_CHART.
  // Stub it to "no missing accounts" so the happy path is exercised.
  findMissingAccountsMock: vi.fn().mockResolvedValue([]),
}))

// Only the commit is stubbed. The dry-run runs the pipeline's real dedup
// decision (lib/transactions/dedup-preview.ts) against the scripted tables.
vi.mock('@/lib/transactions/ingest', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/ingest')>()),
  ingestTransactions: ingestMock,
}))
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return {
    ...actual,
    findMissingActiveAccounts: findMissingAccountsMock,
  }
})

// batch-categorize runs the booking-time duplicate guard per item. Its
// detector reads `transactions`, which this file scripts as an ordered queue
// for the fetch / CAS sequence, so stub it to "no duplicate" (the detection
// queries are unit-tested in lib/transactions/__tests__/booking-duplicate-detection.test.ts).
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as ingestPOST } from '../route'
import { POST as batchPOST } from '../../batch-categorize/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

const SAMPLE_TX = {
  date: '2026-05-12',
  description: 'ICA MAXI',
  amount: -349.5,
  currency: 'SEK',
  external_id: 'csv-line-42',
  merchant_name: 'ICA MAXI',
}

describe('POST /transactions/ingest', () => {
  it('runs the ingest pipeline and returns the result', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions: [SAMPLE_TX, { ...SAMPLE_TX, external_id: 'csv-line-43' }],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.imported).toBe(2)
    expect(body.data.duplicates).toBe(1)
    expect(ingestMock).toHaveBeenCalledTimes(1)
  })

  it('dry-run returns dedup decisions without inserting', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: [], error: null },
      }),
    )
    const res = await ingestPOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest?dry_run=true`,
        { transactions: [SAMPLE_TX] },
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('returns 401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions: [SAMPLE_TX],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(401)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  // A skipped row is named, never only counted: the caller can tell a content
  // match (a judgement call) from an exact external_id match.
  it('returns every skipped row with its reason and the stored row it matched', async () => {
    const skipped = [
      {
        external_id: 'csv-line-43',
        reason: 'content_match_unbooked',
        matched_external_id: 'stored-9',
        matched_transaction_id: '33333333-3333-4333-8333-333333333333',
      },
    ]
    ingestMock.mockResolvedValueOnce({
      imported: 1,
      duplicates: 1,
      duplicates_by_reason: { external_id_match: 0, content_match_booked: 0, content_match_unbooked: 1 },
      skipped,
      reconciled: 0,
      auto_categorized: 0,
      auto_matched_invoices: 0,
      errors: 0,
      transaction_ids: ['11111111-1111-4111-8111-111111111111'],
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions: [SAMPLE_TX, { ...SAMPLE_TX, external_id: 'csv-line-43' }],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.duplicates).toBe(1)
    expect(body.data.duplicates_by_reason).toEqual({
      external_id_match: 0,
      content_match_booked: 0,
      content_match_unbooked: 1,
    })
    expect(body.data.skipped).toEqual(skipped)
  })

  it('passes stable_external_ids to the pipeline', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const tx = { ...SAMPLE_TX, import_source: 'my_bank_feed' }
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions: [tx, { ...tx, external_id: 'ref-2' }],
        stable_external_ids: true,
        settlement_account: '1930',
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(ingestMock.mock.calls[0][4]).toMatchObject({ stableExternalIds: true, settlementAccount: '1930' })
    // The mocked pipeline result predates the per-row fields: the response
    // still carries them, empty, so a client can rely on their presence.
    const body = await res.json()
    expect(body.data.skipped).toEqual([])
    expect(body.data.duplicates_by_reason).toEqual({
      external_id_match: 0,
      content_match_booked: 0,
      content_match_unbooked: 0,
    })
  })

  // The feed label is the id namespace. Without one the statement could not
  // tell "the same feed" from rows typed in by hand, so it is refused instead
  // of silently doing nothing.
  it.each([
    ['no import_source', [SAMPLE_TX]],
    ['a hand-entered label', [{ ...SAMPLE_TX, import_source: 'mcp' }]],
    [
      'two different labels',
      [
        { ...SAMPLE_TX, import_source: 'feed_a' },
        { ...SAMPLE_TX, external_id: 'ref-2', import_source: 'feed_b' },
      ],
    ],
  ])('rejects stable_external_ids with %s', async (_name, transactions) => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions,
        stable_external_ids: true,
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  // What the dry-run says, row by row, is tested end to end against the real
  // pipeline in dry-run-agreement.test.ts.

  it('rejects > 500 items', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const transactions = Array.from({ length: 501 }, (_, i) => ({
      ...SAMPLE_TX,
      external_id: `csv-${i}`,
    }))
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions,
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without transactions:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['transactions:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await ingestPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`, {
        transactions: [SAMPLE_TX],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /transactions/batch-categorize', () => {
  it('categorizes a batch with mixed success/failure', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        transactions: [
          {
            data: {
              id: TX_ID,
              date: '2026-05-12',
              amount: -100,
              currency: 'SEK',
              merchant_name: 'ICA',
              journal_entry_id: null,
            },
            error: null,
          },
          { data: [{ id: TX_ID }], error: null }, // CAS update select for item 0
          { data: null, error: { code: 'PGRST116' } }, // item 1 not found
        ],
      }),
    )

    const res = await batchPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`, {
        items: [
          {
            transaction_id: TX_ID,
            categorization: { is_business: true, category: 'expense_office' },
          },
          {
            transaction_id: '99999999-9999-4999-8999-999999999999',
            categorization: { is_business: true, category: 'expense_office' },
          },
        ],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary.total).toBe(2)
    expect(body.data.summary.succeeded).toBe(1)
    expect(body.data.summary.failed).toBe(1)
    expect(body.data.results[1].error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('rejects all_or_nothing: true with 501', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await batchPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`, {
        all_or_nothing: true,
        items: [{ transaction_id: TX_ID, categorization: { is_business: false } }],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(501)
  })

  it('rejects > 100 items', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const items = Array.from({ length: 101 }, () => ({
      transaction_id: TX_ID,
      categorization: { is_business: false },
    }))
    const res = await batchPOST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`, {
        items,
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })
})
