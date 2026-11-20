/**
 * POST /api/v1/companies/:companyId/transactions/ingest, end to end: the
 * dry-run must predict the commit row by row, and the commit must name every
 * row it skips (GitHub 3496).
 *
 * Nothing of the pipeline is stubbed here. The route's dry-run and its commit
 * both run against the same in-memory tables (tests/ingest-fake-db.ts), which
 * apply the queries' filters, so what the two say about the same request can
 * be compared directly. The request and response shapes are asserted as an
 * API consumer sees them.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIngestFakeDb, FAKE_COMPANY_ID, type IngestFakeDb } from '@/tests/ingest-fake-db'

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
// What the pipeline does AFTER a row is inserted is not under test.
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  evaluateMappingRules: vi.fn().mockResolvedValue({ confidence: 0, requires_review: true }),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: vi.fn(),
}))
vi.mock('@/lib/invoices/invoice-matching', () => ({
  loadInvoiceMatchPool: vi.fn().mockResolvedValue({ invoices: [] }),
  bestInvoiceMatch: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/invoices/rot-rut-payout-candidates', () => ({
  loadOpenRotRutPayoutRequests: vi.fn().mockResolvedValue([]),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = FAKE_COMPANY_ID
const ENDPOINT = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/ingest`

/**
 * The fake answers the tables the pipeline reads and writes; every other
 * table the wrapper touches (idempotency cache, audit) answers "nothing".
 */
function clientFor(db: IngestFakeDb) {
  const nothing = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === 'then'
            ? (resolve: (value: unknown) => void) => resolve({ data: null, error: null })
            : () => nothing(),
      },
    )
  return {
    from: vi.fn((table: string) => (table in db.tables ? db.from(table) : nothing())),
    rpc: vi.fn(() => nothing()),
  }
}

let requestNumber = 0
async function post(body: unknown, options: { dryRun?: boolean } = {}) {
  requestNumber += 1
  const res = await POST(
    new Request(options.dryRun ? `${ENDPOINT}?dry_run=true` : ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': `idem0000-aaaa-4abc-8def-${String(requestNumber).padStart(12, '0')}`,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )
  const json = await res.json()
  return { status: res.status, data: json.data, error: json.error }
}

type PreviewItem = {
  external_id: string
  would_skip: boolean
  skip_reason: string | null
  matched_external_id: string | null
  matched_transaction_id: string | null
}

/** The dry-run items that would be skipped, in the shape the commit reports skips. */
const predictedSkips = (items: PreviewItem[]) =>
  items
    .filter((item) => item.would_skip)
    .map((item) => ({
      external_id: item.external_id,
      reason: item.skip_reason,
      matched_external_id: item.matched_external_id,
      matched_transaction_id: item.matched_transaction_id,
    }))

const FEED = 'my_bank_feed'
const DAY = '2026-05-12'
const fee = (externalId: string, overrides: Record<string, unknown> = {}) => ({
  date: DAY,
  description: 'Transaktionsavgift',
  amount: -12.5,
  currency: 'SEK',
  external_id: externalId,
  import_source: FEED,
  ...overrides,
})

let db: IngestFakeDb

beforeEach(() => {
  vi.clearAllMocks()
  db = createIngestFakeDb()
  db.tables.company_members = [{ user_id: 'user-1', company_id: COMPANY_ID, role: 'owner' }]
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(clientFor(db))
})

describe('POST /transactions/ingest: a third identical fee on the same day', () => {
  // The silent shape: the two stored fees are still unbooked. The dry-run
  // used to answer would_import, the commit dropped the row, and the response
  // said only `duplicates: 1`.
  it('says the same thing in the dry-run and the commit when the stored twins are UNBOOKED', async () => {
    const first = await post({ transactions: [fee('ref-1'), fee('ref-2')] })
    expect(first.status).toBe(200)
    expect(first.data).toMatchObject({ imported: 2, duplicates: 0, skipped: [] })

    const preview = await post({ transactions: [fee('ref-3')] }, { dryRun: true })

    expect(preview.status).toBe(200)
    expect(preview.data.preview).toMatchObject({
      would_import: 0,
      would_skip_duplicates: 1,
      would_skip_by_reason: { external_id_match: 0, content_match_booked: 0, content_match_unbooked: 1 },
    })
    expect(preview.data.preview.items).toEqual([
      {
        external_id: 'ref-3',
        date: DAY,
        amount: -12.5,
        currency: 'SEK',
        would_skip: true,
        skip_reason: 'content_match_unbooked',
        matched_external_id: 'ref-1',
        matched_transaction_id: db.byExternalId('ref-1')!.id,
      },
    ])
    expect(db.stored()).toHaveLength(2) // the dry-run wrote nothing

    const commit = await post({ transactions: [fee('ref-3')] })

    expect(commit.status).toBe(200)
    expect(commit.data.imported).toBe(0)
    expect(commit.data.duplicates).toBe(1)
    expect(commit.data.duplicates_by_reason).toEqual(preview.data.preview.would_skip_by_reason)
    expect(commit.data.skipped).toEqual(predictedSkips(preview.data.preview.items))
    expect(db.stored()).toHaveLength(2)
  })

  // The loud shape: the stored fees are booked.
  it('says the same thing in the dry-run and the commit when the stored twins are BOOKED', async () => {
    await post({ transactions: [fee('ref-1'), fee('ref-2')] })
    db.book('ref-1', 'ref-2')

    const preview = await post({ transactions: [fee('ref-3')] }, { dryRun: true })
    const commit = await post({ transactions: [fee('ref-3')] })

    expect(preview.data.preview.items[0]).toMatchObject({
      would_skip: true,
      skip_reason: 'content_match_booked',
      matched_external_id: 'ref-1',
    })
    expect(commit.data.skipped).toEqual(predictedSkips(preview.data.preview.items))
    expect(commit.data.imported).toBe(0)
  })

  it.each([
    ['booked', true],
    ['unbooked', false],
  ])('imports it when the feed states stable ids and the stored twins are %s', async (_state, booked) => {
    await post({ transactions: [fee('ref-1'), fee('ref-2')], stable_external_ids: true })
    if (booked) db.book('ref-1', 'ref-2')

    const preview = await post({ transactions: [fee('ref-3')], stable_external_ids: true }, { dryRun: true })
    const commit = await post({ transactions: [fee('ref-3')], stable_external_ids: true })

    expect(preview.data.preview).toMatchObject({ would_import: 1, would_skip_duplicates: 0 })
    expect(preview.data.preview.items[0]).toMatchObject({ would_skip: false, skip_reason: null })
    expect(commit.data).toMatchObject({ imported: 1, duplicates: 0, skipped: [] })
    expect(db.stored().map((row) => row.external_id)).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })

  it('imports three identical fees sent in one call', async () => {
    const preview = await post({ transactions: [fee('ref-1'), fee('ref-2'), fee('ref-3')] }, { dryRun: true })
    const commit = await post({ transactions: [fee('ref-1'), fee('ref-2'), fee('ref-3')] })

    expect(preview.data.preview.would_import).toBe(3)
    expect(commit.data).toMatchObject({ imported: 3, duplicates: 0, skipped: [] })
  })
})

describe('POST /transactions/ingest: the dry-run predicts the commit', () => {
  const ACCOUNT = { id: 'cash-1930', company_id: COMPANY_ID, ledger_account: '1930', iban: 'SE0000000000000000000001', currency: 'SEK', enabled: true }

  it('row by row for a batch that takes every path of the decision', async () => {
    db.tables.cash_accounts.push(ACCOUNT)
    const on1930 = { cash_account_id: ACCOUNT.id }
    db.seed({ ...fee('ref-1'), journal_entry_id: 'je-1', ...on1930 })
    db.seed({ ...fee('ref-2'), ...on1930 })
    db.seed({ date: DAY, description: 'Hyra maj', amount: -9000, import_source: 'csv_testbank', external_id: 'csv-rent', journal_entry_id: 'je-2', ...on1930 })
    db.seed({ date: '2026-05-13', description: 'BOLAGET AB', amount: -700, import_source: 'csv_testbank', external_id: 'csv-payee', ...on1930 })
    db.seed({ date: '2026-05-14', description: 'Egen insättning', amount: 5000, import_source: 'mcp', external_id: null, journal_entry_id: 'je-3' })

    const body = {
      settlement_account: '1930',
      stable_external_ids: true,
      transactions: [
        fee('ref-2'), // stored under this id
        fee('ref-3'), // a new reference, identical to two stored rows of this feed
        fee('ref-rent', { description: 'Hyra maj Fastighets AB', amount: -9000 }), // bridges a booked file row
        fee('ref-payee', { date: '2026-05-13', description: 'OCR 55512', amount: -700 }), // mirrors a file row
        fee('ref-deposit', { date: '2026-05-14', description: 'Insättning 4411', amount: 5000 }), // a hand booking
        fee('ref-new', { date: '2026-05-15', description: 'Nytt köp', amount: -99 }), // nothing like it stored
      ],
    }

    const preview = await post(body, { dryRun: true })
    expect(db.writes).toEqual([])
    const commit = await post(body)

    expect(preview.status).toBe(200)
    expect(commit.status).toBe(200)
    const items: PreviewItem[] = preview.data.preview.items
    expect(items.map((item) => [item.external_id, item.skip_reason])).toEqual([
      ['ref-2', 'external_id_match'],
      ['ref-3', null],
      ['ref-rent', 'content_match_booked'],
      ['ref-payee', 'content_match_unbooked'],
      ['ref-deposit', 'content_match_booked'],
      ['ref-new', null],
    ])
    // Skipped: the same rows, reasons and stored rows.
    expect(commit.data.skipped).toEqual(predictedSkips(items))
    expect(commit.data.duplicates).toBe(preview.data.preview.would_skip_duplicates)
    expect(commit.data.duplicates_by_reason).toEqual(preview.data.preview.would_skip_by_reason)
    // Imported: the same rows.
    expect(commit.data.imported).toBe(preview.data.preview.would_import)
    const inserted = db.stored().filter((row) => commit.data.transaction_ids.includes(row.id)).map((row) => row.external_id)
    expect(inserted).toEqual(items.filter((item) => !item.would_skip).map((item) => item.external_id))
    // Every row sent is either imported or named as skipped.
    expect(commit.data.imported + commit.data.skipped.length).toBe(body.transactions.length)
  })

  it('returns 404 for a company the key is not a member of', async () => {
    db.tables.company_members = []

    const res = await post({ transactions: [fee('ref-1')] })

    expect(res.status).toBe(404)
    expect(db.stored()).toHaveLength(0)
  })
})
