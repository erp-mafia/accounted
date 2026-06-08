/**
 * Tests for the generic transaction ingestion pipeline.
 *
 * Covers deduplication, insert, invoice matching, auto-categorization,
 * and result aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ingestTransactions, type RawTransaction } from '../ingest'
import { makeJournalEntry, makeTransaction } from '@/tests/helpers'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEvaluateMappingRules = vi.fn()
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  evaluateMappingRules: (...args: unknown[]) => mockEvaluateMappingRules(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) =>
    mockCreateTransactionJournalEntry(...args),
}))

const mockGetBestInvoiceMatch = vi.fn()
vi.mock('@/lib/invoices/invoice-matching', () => ({
  getBestInvoiceMatch: (...args: unknown[]) => mockGetBestInvoiceMatch(...args),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

// ---------------------------------------------------------------------------
// Queue-based Supabase mock
// ---------------------------------------------------------------------------

function createQueueMockSupabase() {
  const resultQueue: { data: unknown; error: unknown }[] = []
  // Captures .insert() payloads keyed by table, so tests can assert what was
  // written (e.g. cash_account_id stamping).
  const inserts: Record<string, unknown[]> = {}

  /**
   * Push one or more results onto the queue.
   * Each awaited Supabase chain pops the next result in FIFO order.
   */
  const enqueue = (...results: { data?: unknown; error?: unknown }[]) => {
    for (const r of results) {
      resultQueue.push({ data: r.data ?? null, error: r.error ?? null })
    }
  }

  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          const next = resultQueue.shift() ?? { data: null, error: null }
          return (resolve: (v: unknown) => void) => resolve(next)
        }
        if (prop === 'insert') {
          return (payload: unknown) => {
            ;(inserts[table] ??= []).push(payload)
            return buildChain(table)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => buildChain(table)),
    rpc: vi.fn().mockImplementation(() => buildChain('rpc')),
  }

  return { supabase, enqueue, inserts }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1'
const COMPANY_ID = 'company-1'

function makeRaw(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    date: '2024-06-15',
    description: 'Test transaction',
    amount: -250.0,
    currency: 'SEK',
    external_id: `ext-${Math.random().toString(36).slice(2, 8)}`,
    mcc_code: null,
    merchant_name: null,
    reference: null,
    bank_connection_id: null,
    import_source: 'test',
    ...overrides,
  }
}

function makeMappingResult(overrides: Record<string, unknown> = {}) {
  return {
    rule: null,
    debit_account: '5410',
    credit_account: '1930',
    risk_level: 'low',
    confidence: 0.9,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Office supplies',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
//
// Queue order after batch dedup refactor:
// 1. Booked transaction map query
// 1b. Unbooked bank-synced transaction map query
// 2. Supplier invoices fetch
// 3. Batch external_id dedup query (returns matching external_ids)
// 4. Per-transaction: insert, updates, etc.
// ---------------------------------------------------------------------------

describe('ingestTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -----------------------------------------------------------------------
  // 1. Successfully imports new transactions
  // -----------------------------------------------------------------------
  it('imports new transactions when no duplicate exists', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -100 })
    const inserted = makeTransaction({ id: 'tx-1', external_id: raw.external_id })

    // Booked transaction map query (no booked transactions)
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch (no unpaid invoices)
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert returns the new transaction
    enqueue({ data: inserted, error: null })
    // evaluateMappingRules will be called but we want low confidence
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-1'])
  })

  // -----------------------------------------------------------------------
  // 1c. Stamps cash_account_id from the settlement account
  // -----------------------------------------------------------------------
  it('stamps cash_account_id on the insert when settlementAccount resolves', async () => {
    const { supabase, enqueue, inserts } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -100 })
    const inserted = makeTransaction({ id: 'tx-1', external_id: raw.external_id })

    enqueue({ data: [], error: null }) // booked map
    enqueue({ data: [], error: null }) // unbooked map
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup
    enqueue({ data: { id: 'ca-1931' }, error: null }) // cash_accounts lookup
    enqueue({ data: inserted, error: null }) // insert
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw], {
      settlementAccount: '1931',
    })

    expect(result.imported).toBe(1)
    expect(supabase.from).toHaveBeenCalledWith('cash_accounts')
    const txInserts = inserts['transactions'] ?? []
    expect(txInserts).toHaveLength(1)
    expect((txInserts[0] as { cash_account_id?: string | null }).cash_account_id).toBe('ca-1931')
  })

  it('inserts cash_account_id null when no settlementAccount is given', async () => {
    const { supabase, enqueue, inserts } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -100 })
    const inserted = makeTransaction({ id: 'tx-1', external_id: raw.external_id })

    enqueue({ data: [], error: null }) // booked map
    enqueue({ data: [], error: null }) // unbooked map
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup
    // No cash_accounts lookup — settlementAccount omitted.
    enqueue({ data: inserted, error: null }) // insert
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(supabase.from).not.toHaveBeenCalledWith('cash_accounts')
    const txInserts = inserts['transactions'] ?? []
    expect((txInserts[0] as { cash_account_id?: string | null }).cash_account_id).toBeNull()
  })

  // -----------------------------------------------------------------------
  // 2. Detects duplicates
  // -----------------------------------------------------------------------
  it('detects duplicates via external_id', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw()

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — returns matching external_id
    enqueue({ data: [{ external_id: raw.external_id }], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.transaction_ids).toEqual([])
  })

  // -----------------------------------------------------------------------
  // 2b. CSV row dedupes against uncategorized enable_banking row when
  //     date+amount+description prefix match (Lunar CSV vs Lunar PSD2 case).
  // -----------------------------------------------------------------------
  it('dedupes CSV row against unbooked enable_banking row with matching description', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2024-06-15',
      amount: -250.0,
      description: 'ICA Maxi Solna',
      external_id: 'lunar_csvhash123',
      import_source: 'csv_lunar',
    })

    // Booked transaction map query — none
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query — one PSD2 row with matching content
    enqueue({
      data: [{ date: '2024-06-15', amount: -250.0, description: 'ICA Maxi Solna' }],
      error: null,
    })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — external_id differs, so no match
    enqueue({ data: [], error: null })
    // No insert expected — row should be deduplicated at content layer

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.transaction_ids).toEqual([])
  })

  // -----------------------------------------------------------------------
  // 2b-edit. Edit-safety regression: a user-edited stored title must NOT
  //     reopen the duplicate-import window. The content bridge keys off the
  //     immutable original_description, so a re-import whose bank text still
  //     matches the original is deduped even though the stored (editable)
  //     description was changed.
  // -----------------------------------------------------------------------
  it('dedupes against the original bank description even after the stored title was edited', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2024-06-15',
      amount: -250.0,
      description: 'ICA Maxi Solna', // original bank text, re-imported via CSV
      external_id: 'lunar_csvhash999', // different external_id → primary dedup misses
      import_source: 'csv_lunar',
    })

    // Booked transaction map query — none
    enqueue({ data: [], error: null })
    // Unbooked bank-synced row whose TITLE was edited by the user, but whose
    // original_description still holds the bank's verbatim text.
    enqueue({
      data: [
        {
          date: '2024-06-15',
          amount: -250.0,
          original_description: 'ICA Maxi Solna',
          description: 'Mataffär (egen rubrik)',
        },
      ],
      error: null,
    })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — external_id differs, so no match
    enqueue({ data: [], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 2b-unknown. Legacy 'Unknown'/empty rows must still dedup: the stored-side
  //     content key is normalized the same way as the incoming side, so an
  //     existing row whose original_description is the legacy 'Unknown'
  //     sentinel matches an incoming 'Unknown' re-import (both → 'Okänd
  //     transaktion'). Without symmetric normalization this row would
  //     re-import as a duplicate.
  // -----------------------------------------------------------------------
  it('dedupes legacy "Unknown" rows by normalizing both the stored and incoming keys', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2024-06-15',
      amount: -250.0,
      description: 'Unknown', // legacy English sentinel re-imported via CSV
      external_id: 'lunar_csvhashU',
      import_source: 'csv_lunar',
    })

    // Booked transaction map query — none
    enqueue({ data: [], error: null })
    // Unbooked bank-synced row whose original_description is the legacy sentinel.
    enqueue({
      data: [{ date: '2024-06-15', amount: -250.0, original_description: 'Unknown', description: 'Unknown' }],
      error: null,
    })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — external_id differs, so no match
    enqueue({ data: [], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 2c. No false positive: same date+amount but different description does
  //     NOT trigger content dedup — guards against the historical concern
  //     about unrelated transfers colliding on (date, amount) alone.
  // -----------------------------------------------------------------------
  it('does not dedupe when date+amount match but description differs', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2024-06-15',
      amount: -250.0,
      description: 'Coop Stockholm',
      external_id: 'lunar_csvhash456',
      import_source: 'csv_lunar',
    })
    const inserted = makeTransaction({
      id: 'tx-no-collision',
      external_id: raw.external_id,
      amount: -250.0,
    })

    // Booked transaction map query — none
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query — a PSD2 row with same date/amount but DIFFERENT description
    enqueue({
      data: [{ date: '2024-06-15', amount: -250.0, description: 'ICA Maxi Solna' }],
      error: null,
    })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — no match
    enqueue({ data: [], error: null })
    // Insert succeeds — the new row is not a duplicate
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-no-collision'])
  })

  // -----------------------------------------------------------------------
  // 2d. Description drift: PSD2 enrichment is prefix-preserving, so an
  //     enriched re-import ("TIC" → "TIC  BG … via internet") still bridges
  //     the stored original via prefix-containment. This is the June 2026
  //     incident: the external_id ALSO changed, so the bridge is the only net.
  // -----------------------------------------------------------------------
  it('dedupes an enriched re-import whose description extends the stored original', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2026-04-07',
      amount: -11231,
      description: 'KAFFE              BG 0000000000 Bg-bet. via internet', // enriched
      external_id: 'eb_SE00_2026-04-07_-1123100_0', // NEW-scheme id → external_id dedup misses
      import_source: 'enable_banking',
    })

    enqueue({ data: [], error: null }) // booked map — none
    // Unbooked enable_banking row carrying the SHORT original description.
    enqueue({
      data: [{ date: '2026-04-07', amount: -11231, original_description: 'KAFFE', description: 'KAFFE' }],
      error: null,
    })
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup — different scheme, no match

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 2e. Order-independence: a genuinely-new row whose description does NOT
  //     bridge an existing same-(date,amount) row is kept, and the re-import
  //     that DOES bridge is deduped — regardless of provider ordering.
  // -----------------------------------------------------------------------
  it.each([
    ['new-first', ['Lunch', 'Coffee']],
    ['dup-first', ['Coffee', 'Lunch']],
  ])('keeps the distinct row and dedupes the bridging twin (%s)', async (_label, order) => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const rows = order.map((desc, i) =>
      makeRaw({
        date: '2026-04-07',
        amount: -250,
        description: desc,
        external_id: `csv_${desc}_${i}`,
        import_source: 'csv_lunar',
      }),
    )
    const insertedDesc = 'Lunch' // the non-bridging "Lunch" is always the row that gets inserted

    enqueue({ data: [], error: null }) // booked map — none
    // One unbooked enable_banking row "Coffee" — only the incoming "Coffee" bridges it.
    enqueue({
      data: [{ date: '2026-04-07', amount: -250, original_description: 'Coffee', description: 'Coffee' }],
      error: null,
    })
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup — no match
    enqueue({
      data: makeTransaction({ id: 'tx-lunch', description: insertedDesc, amount: -250 }),
      error: null,
    }) // insert for the non-bridging "Lunch"
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, rows)

    expect(result.imported).toBe(1) // "Lunch" kept
    expect(result.duplicates).toBe(1) // "Coffee" deduped
    expect(result.transaction_ids).toEqual(['tx-lunch'])
  })

  // -----------------------------------------------------------------------
  // 2f. Counting semantics: N stored twins dedup exactly N incoming bridging
  //     rows; the surplus is inserted (never silently collapsed).
  // -----------------------------------------------------------------------
  it('dedupes exactly as many incoming rows as there are stored twins (counting)', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const rows = [1, 2, 3].map((n) =>
      makeRaw({
        date: '2026-04-07',
        amount: -100,
        description: `ICA Kortköp ${n}`,
        external_id: `csv_ica_${n}`,
        import_source: 'csv_lunar',
      }),
    )

    enqueue({ data: [], error: null }) // booked map — none
    // Two stored unbooked "ICA" twins → only two of the three incoming dedup.
    enqueue({
      data: [
        { date: '2026-04-07', amount: -100, original_description: 'ICA', description: 'ICA' },
        { date: '2026-04-07', amount: -100, original_description: 'ICA', description: 'ICA' },
      ],
      error: null,
    })
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup — no match
    enqueue({
      data: makeTransaction({ id: 'tx-ica-surplus', description: 'ICA Kortköp 3', amount: -100 }),
      error: null,
    }) // insert for the surplus third row
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, rows)

    expect(result.duplicates).toBe(2)
    expect(result.imported).toBe(1)
    expect(result.transaction_ids).toEqual(['tx-ica-surplus'])
  })

  // -----------------------------------------------------------------------
  // 2g. Cross-account guard: a transaction on one bank account must NOT
  //     deduplicate a genuinely-different one on ANOTHER account of the same
  //     company. The content bucket is company-wide (only external_id embeds
  //     the account), so the bridge also requires matching cash_account_id when
  //     both sides know it.
  // -----------------------------------------------------------------------
  it('does not dedupe a bridging twin that settled on a different cash account', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2026-04-07',
      amount: -250,
      description: 'Avgift',
      external_id: 'eb_acctB_2026-04-07_-25000_0',
      import_source: 'enable_banking',
    })
    const inserted = makeTransaction({ id: 'tx-acctB', amount: -250 })

    enqueue({ data: [], error: null }) // booked map — none
    // Unbooked enable_banking twin, but it settled on a DIFFERENT account (A).
    enqueue({
      data: [{ date: '2026-04-07', amount: -250, original_description: 'Avgift', description: 'Avgift', cash_account_id: 'acct-A' }],
      error: null,
    })
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup — no match
    enqueue({ data: { id: 'acct-B' }, error: null }) // cash_accounts lookup → batch settled on account B
    enqueue({ data: inserted, error: null }) // insert — not a duplicate
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw], {
      settlementAccount: '1931',
    })

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-acctB'])
  })

  it('dedupes a bridging twin on the SAME cash account', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      date: '2026-04-07',
      amount: -250,
      description: 'Avgift',
      external_id: 'eb_acctA_2026-04-07_-25000_99', // different id → external_id dedup misses
      import_source: 'enable_banking',
    })

    enqueue({ data: [], error: null }) // booked map — none
    enqueue({
      data: [{ date: '2026-04-07', amount: -250, original_description: 'Avgift', description: 'Avgift', cash_account_id: 'acct-A' }],
      error: null,
    })
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // external_id dedup — no match
    enqueue({ data: { id: 'acct-A' }, error: null }) // cash_accounts lookup → batch settled on account A (same)
    // No insert — deduped.

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw], {
      settlementAccount: '1930',
    })

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  // -----------------------------------------------------------------------
  // 3. Counts errors when insert fails
  // -----------------------------------------------------------------------
  it('counts errors when insert fails', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw()

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert fails
    enqueue({ data: null, error: { message: 'DB constraint violation' } })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.errors).toBe(1)
    expect(result.imported).toBe(0)
    expect(result.transaction_ids).toEqual([])
  })

  // -----------------------------------------------------------------------
  // 4. Auto-matches invoices for income transactions (amount > 0)
  // -----------------------------------------------------------------------
  it('auto-matches invoices for income transactions', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: 5000, description: 'Payment received' })
    const inserted = makeTransaction({
      id: 'tx-income',
      amount: 5000,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert returns the new transaction
    enqueue({ data: inserted, error: null })
    // Invoice match update (supabase.from('transactions').update(...))
    enqueue({ data: null, error: null })
    // Mapping rules auto-categorization update (if triggered)
    enqueue({ data: null, error: null })

    mockGetBestInvoiceMatch.mockResolvedValue({
      invoice: { id: 'inv-1' },
      confidence: 0.95,
      matchReason: 'OCR reference match',
    })
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_matched_invoices).toBe(1)
    expect(mockGetBestInvoiceMatch).toHaveBeenCalledWith(
      expect.anything(), // supabase client
      COMPANY_ID,
      expect.objectContaining({ id: 'tx-income' }),
      0.50
    )
  })

  // -----------------------------------------------------------------------
  // 5. Does not attempt invoice matching for expenses (amount < 0)
  // -----------------------------------------------------------------------
  it('does not attempt invoice matching for expenses', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -350 })
    const inserted = makeTransaction({
      id: 'tx-expense',
      amount: -350,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.auto_matched_invoices).toBe(0)
    expect(mockGetBestInvoiceMatch).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 6. Auto-categorizes when mapping confidence >= 0.8
  // -----------------------------------------------------------------------
  it('auto-categorizes when mapping confidence is at least 0.8', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -500, mcc_code: 5411, merchant_name: 'ICA' })
    const inserted = makeTransaction({
      id: 'tx-cat',
      amount: -500,
      external_id: raw.external_id,
    })
    const journalEntry = makeJournalEntry({ id: 'je-1' })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })
    // Update after journal entry creation
    enqueue({ data: null, error: null })

    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.85, requires_review: false })
    )
    mockCreateTransactionJournalEntry.mockResolvedValue(journalEntry)

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_categorized).toBe(1)
    expect(mockCreateTransactionJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({ id: 'tx-cat' }),
      expect.objectContaining({ confidence: 0.85 })
    )
  })

  // -----------------------------------------------------------------------
  // 7. Skips auto-categorization when confidence < 0.8
  // -----------------------------------------------------------------------
  it('skips auto-categorization when confidence is below 0.8', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -200 })
    const inserted = makeTransaction({
      id: 'tx-lowconf',
      amount: -200,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.6 })
    )

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_categorized).toBe(0)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 7b. Skips auto-categorization when requires_review is true
  // -----------------------------------------------------------------------
  it('skips auto-categorization when requires_review is true even if confidence is high', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -800 })
    const inserted = makeTransaction({
      id: 'tx-review',
      amount: -800,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.95, requires_review: true })
    )

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.auto_categorized).toBe(0)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // 8. Returns correct IngestResult totals
  // -----------------------------------------------------------------------
  it('returns correct IngestResult totals', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw1 = makeRaw({ external_id: 'ext-a', amount: -100 })
    const raw2 = makeRaw({ external_id: 'ext-b', amount: -200 })

    const inserted1 = makeTransaction({ id: 'tx-a', amount: -100 })
    const inserted2 = makeTransaction({ id: 'tx-b', amount: -200 })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Transaction 1: insert OK
    enqueue({ data: inserted1, error: null })
    // Transaction 2: insert OK
    enqueue({ data: inserted2, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw1, raw2])

    expect(result.imported).toBe(2)
    expect(result.duplicates).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.auto_categorized).toBe(0)
    expect(result.auto_matched_invoices).toBe(0)
    expect(result.transaction_ids).toEqual(['tx-a', 'tx-b'])
  })

  // -----------------------------------------------------------------------
  // 9. Handles mixed batch (new, duplicates, errors)
  // -----------------------------------------------------------------------
  it('handles a mixed batch of new transactions, duplicates, and errors', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    const rawNew = makeRaw({ external_id: 'ext-new', amount: 3000 })
    const rawDup = makeRaw({ external_id: 'ext-dup', amount: -150 })
    const rawErr = makeRaw({ external_id: 'ext-err', amount: -75 })

    const insertedNew = makeTransaction({
      id: 'tx-new',
      amount: 3000,
      external_id: 'ext-new',
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — ext-dup already exists
    enqueue({ data: [{ external_id: 'ext-dup' }], error: null })
    // Transaction rawNew: insert OK
    enqueue({ data: insertedNew, error: null })
    // Invoice match update for income transaction
    enqueue({ data: null, error: null })
    // logMatchEvent insert (fire-and-forget)
    enqueue({ data: null, error: null })
    // rawDup: skipped (in Set) — no queue entry needed
    // NOTE: auto-categorization is skipped because invoice match triggers `continue`
    // Transaction rawErr: insert fails
    enqueue({ data: null, error: { message: 'Insert failed' } })

    // Income transaction gets an invoice match
    mockGetBestInvoiceMatch.mockResolvedValue({
      invoice: { id: 'inv-match' },
      confidence: 0.95,
      matchReason: 'Exact amount match',
    })

    // Auto-categorization with high confidence
    mockEvaluateMappingRules.mockResolvedValue(
      makeMappingResult({ confidence: 0.85 })
    )
    const journalEntry = makeJournalEntry({ id: 'je-mixed' })
    mockCreateTransactionJournalEntry.mockResolvedValue(journalEntry)

    const result = await ingestTransactions(
      supabase as never,
      COMPANY_ID,
      USER_ID,
      [rawNew, rawDup, rawErr]
    )

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.auto_matched_invoices).toBe(1)
    expect(result.auto_categorized).toBe(0) // Skipped: invoice match triggers continue
    expect(result.transaction_ids).toEqual(['tx-new'])
  })

  // -----------------------------------------------------------------------
  // Edge: empty input array
  // -----------------------------------------------------------------------
  it('returns zero totals for an empty input array', async () => {
    const { supabase } = createQueueMockSupabase()

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [])

    expect(result).toEqual({
      imported: 0,
      duplicates: 0,
      reconciled: 0,
      auto_categorized: 0,
      auto_matched_invoices: 0,
      errors: 0,
      transaction_ids: [],
    })
  })

  // -----------------------------------------------------------------------
  // Edge: invoice matching error is non-critical
  // -----------------------------------------------------------------------
  it('continues processing when invoice matching throws', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: 1000 })
    const inserted = makeTransaction({ id: 'tx-inv-err', amount: 1000 })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    enqueue({ data: inserted, error: null })

    mockGetBestInvoiceMatch.mockRejectedValue(new Error('Network error'))
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    // Should still count as imported even though invoice matching failed
    expect(result.imported).toBe(1)
    expect(result.auto_matched_invoices).toBe(0)
    expect(result.errors).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Edge: auto-categorization error is non-critical
  // -----------------------------------------------------------------------
  it('continues processing when auto-categorization throws', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -400 })
    const inserted = makeTransaction({ id: 'tx-cat-err', amount: -400 })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockRejectedValue(new Error('Mapping error'))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.auto_categorized).toBe(0)
    expect(result.errors).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Imports never auto-link to existing journal entries.
  // Reconciliation must be an explicit user action (manualLink / runReconciliation).
  // Regression: viktor@frnzn.com — bank txns from 2026 were silently linked
  // to SIE-imported vouchers, surfacing them as "bokförda" without action.
  // -----------------------------------------------------------------------
  it('never auto-reconciles imported transactions to existing GL lines', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -500, external_id: 'ext-recon' })
    const inserted = makeTransaction({
      id: 'tx-recon',
      amount: -500,
      external_id: 'ext-recon',
      currency: 'SEK',
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.reconciled).toBe(0)
  })

  // -----------------------------------------------------------------------
  // rawInsertOnly: skips reconciliation, matching, and auto-categorization
  // -----------------------------------------------------------------------
  it('skips reconciliation, matching, and categorization when rawInsertOnly is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: 5000, description: 'Payment received' })
    const inserted = makeTransaction({
      id: 'tx-raw',
      amount: 5000,
      external_id: raw.external_id,
    })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // No supplier invoices fetch (skipped by rawInsertOnly)
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert returns the new transaction
    enqueue({ data: inserted, error: null })

    const result = await ingestTransactions(
      supabase as never, COMPANY_ID, USER_ID, [raw],
      { rawInsertOnly: true }
    )

    expect(result.imported).toBe(1)
    expect(result.reconciled).toBe(0)
    expect(result.auto_categorized).toBe(0)
    expect(result.auto_matched_invoices).toBe(0)
    // Should NOT have attempted any post-insert operations
    expect(mockGetBestInvoiceMatch).not.toHaveBeenCalled()
    expect(mockEvaluateMappingRules).not.toHaveBeenCalled()
  })

  it('still deduplicates when rawInsertOnly is set', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ external_id: 'ext-dup-raw' })

    // Booked transaction map query
    enqueue({ data: [], error: null })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — already exists
    enqueue({ data: [{ external_id: 'ext-dup-raw' }], error: null })

    const result = await ingestTransactions(
      supabase as never, COMPANY_ID, USER_ID, [raw],
      { rawInsertOnly: true }
    )

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Content-based dedup: cross-source duplicate detection
  // -----------------------------------------------------------------------
  it('skips transactions that match already-booked ones by date+amount+description', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      external_id: 'psd2_conn123_tx456',
      date: '2024-06-15',
      amount: -250,
    })

    // Booked transaction map returns a booked tx with same date+amount+description
    enqueue({
      data: [{ date: '2024-06-15', amount: -250, description: raw.description }],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no match by external_id)
    enqueue({ data: [], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  it('imports transactions when booked ones have different amounts', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      external_id: 'psd2_conn123_tx789',
      date: '2024-06-15',
      amount: -300,
    })
    const inserted = makeTransaction({ id: 'tx-new', amount: -300 })

    // Booked transaction map: same date but different amount
    enqueue({
      data: [{ date: '2024-06-15', amount: -250, description: raw.description }],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no match)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
  })

  it('bridges the external_id scheme change: a booked OLD-scheme eb_ row is caught by content dedup on re-sync', async () => {
    // Transition scenario: an enable_banking row was imported+booked under the
    // OLD unstable scheme (eb_{iban}_{txid}). After deploy, the re-sync derives
    // a NEW content-based external_id that will NOT match by external_id, so
    // layer-1 misses. Layer 1b (booked content dedup) MUST catch it, otherwise
    // the user sees the exact duplicate the fix is meant to prevent.
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      external_id: 'eb_SE123_2024-06-15_-25000_0', // new scheme
      date: '2024-06-15',
      amount: -250,
      description: 'ICA Maxi Solna',
      import_source: 'enable_banking',
    })

    // Booked map: the SAME transaction still carries its OLD-scheme external_id
    // in the DB; dedup matches on content, not on external_id.
    enqueue({
      data: [{ date: '2024-06-15', amount: -250, description: 'ICA Maxi Solna' }],
      error: null,
    })
    // Unbooked enable_banking map — none
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query — DB still holds eb_SE123_{old_txid}, so the
    // new external_id finds NO match here.
    enqueue({ data: [], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  it('dedupes against a booked row whose amount is a numeric string (PostgREST), not a number', async () => {
    // Regression: PostgREST can serialize a `numeric` column as a string
    // ("-250.00") while the incoming raw amount is a JS number (-250). Before
    // the öre-normalized dedup key these never compared equal, so content dedup
    // silently missed and the row was re-imported as a duplicate.
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({
      external_id: 'eb_acc_2024-06-15_-25000_0',
      date: '2024-06-15',
      amount: -250,
      description: 'ICA Maxi Solna',
    })

    // Booked map: same transaction, amount as a STRING with trailing zeros.
    enqueue({
      data: [{ date: '2024-06-15', amount: '-250.00', description: 'ICA Maxi Solna' }],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no match by external_id — the id scheme changed)
    enqueue({ data: [], error: null })

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.duplicates).toBe(1)
    expect(result.imported).toBe(0)
  })

  it('handles multiple booked transactions with same date+amount correctly', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()

    // Three incoming transactions with the same date+amount
    const raw1 = makeRaw({ external_id: 'psd2_a', date: '2024-06-15', amount: -100 })
    const raw2 = makeRaw({ external_id: 'psd2_b', date: '2024-06-15', amount: -100 })
    const raw3 = makeRaw({ external_id: 'psd2_c', date: '2024-06-15', amount: -100 })

    const inserted = makeTransaction({ id: 'tx-new', amount: -100 })

    // Booked map: 2 existing booked transactions with same date+amount+description
    // So 2 of the 3 incoming should be skipped, 1 should be imported
    enqueue({
      data: [
        { date: '2024-06-15', amount: -100, description: raw1.description },
        { date: '2024-06-15', amount: -100, description: raw1.description },
      ],
      error: null,
    })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches for any)
    enqueue({ data: [], error: null })

    // raw1: not in external_id set → content dedup matches (bookedCount=2 -> 1)
    // raw2: not in external_id set → content dedup matches (bookedCount=1 -> 0)
    // raw3: not in external_id set → content dedup exhausted → insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw1, raw2, raw3])

    expect(result.duplicates).toBe(2)
    expect(result.imported).toBe(1)
  })

  // -----------------------------------------------------------------------
  // FX rate fetching (issue #442)
  // Each non-SEK transaction must be priced at the rate of its OWN date,
  // not the import date and not a single batch-level rate.
  // -----------------------------------------------------------------------
  it('fetches an exchange rate per unique (currency, date) pair', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw1 = makeRaw({ amount: -100, currency: 'USD', date: '2026-05-07', external_id: 'usd-a' })
    const raw2 = makeRaw({ amount: -50, currency: 'USD', date: '2026-05-08', external_id: 'usd-b' })
    const raw3 = makeRaw({ amount: -200, currency: 'EUR', date: '2026-05-07', external_id: 'eur-a' })
    const raw4 = makeRaw({ amount: -300, currency: 'USD', date: '2026-05-07', external_id: 'usd-c' })

    enqueue({ data: [], error: null }) // booked map
    enqueue({ data: [], error: null }) // unbooked enable_banking map
    enqueue({ data: [], error: null }) // supplier invoices
    enqueue({ data: [], error: null }) // batch external_id dedup
    enqueue({ data: makeTransaction({ id: 'tx-1' }), error: null })
    enqueue({ data: makeTransaction({ id: 'tx-2' }), error: null })
    enqueue({ data: makeTransaction({ id: 'tx-3' }), error: null })
    enqueue({ data: makeTransaction({ id: 'tx-4' }), error: null })

    mockFetchExchangeRate.mockResolvedValue({ currency: 'USD', rate: 9.2, date: '2026-05-07' })
    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw1, raw2, raw3, raw4])

    // 3 unique pairs: USD/2026-05-07, USD/2026-05-08, EUR/2026-05-07.
    // raw4 reuses USD/2026-05-07 and must NOT trigger an extra fetch.
    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(3)
    const pairs = mockFetchExchangeRate.mock.calls.map(([currency, date]) => ({
      currency,
      date: (date as Date).toISOString().split('T')[0],
    }))
    expect(pairs).toContainEqual({ currency: 'USD', date: '2026-05-07' })
    expect(pairs).toContainEqual({ currency: 'USD', date: '2026-05-08' })
    expect(pairs).toContainEqual({ currency: 'EUR', date: '2026-05-07' })
  })

  it('does not fetch a rate for SEK transactions', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -100, currency: 'SEK', date: '2026-05-07' })

    enqueue({ data: [], error: null }) // booked
    enqueue({ data: [], error: null }) // unbooked
    enqueue({ data: [], error: null }) // suppliers
    enqueue({ data: [], error: null }) // dedup
    enqueue({ data: makeTransaction({ id: 'tx-sek' }), error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('continues normally when booked transaction map query fails', async () => {
    const { supabase, enqueue } = createQueueMockSupabase()
    const raw = makeRaw({ amount: -200 })
    const inserted = makeTransaction({ id: 'tx-mapfail', amount: -200 })

    // Booked map query throws (caught by try/catch in buildExistingTransactionMap)
    enqueue({ error: { message: 'Query failed' } })
    // Unbooked bank-synced transaction map query
    enqueue({ data: [], error: null })
    // Supplier invoices fetch
    enqueue({ data: [], error: null })
    // Batch external_id dedup query (no matches)
    enqueue({ data: [], error: null })
    // Insert
    enqueue({ data: inserted, error: null })

    mockEvaluateMappingRules.mockResolvedValue(makeMappingResult({ confidence: 0.5 }))

    const result = await ingestTransactions(supabase as never, COMPANY_ID, USER_ID, [raw])

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
  })
})
