/**
 * Identical bank rows on one day: which are copies, which are movements.
 *
 * A bank can book several identical movements on one day (the same fee, the
 * same amount, the same text), each with its own bank reference. The content
 * bridge exists to skip re-imports; it must never take one of those for a copy
 * of another (GitHub 3496). These tests run the real pipeline against
 * in-memory tables (tests/ingest-fake-db.ts) instead of a scripted queue, so a
 * scenario is told the way it happens: ingest, book, ingest again, and look at
 * what is stored.
 *
 * They pin, in order:
 *  - the invariant: rows of one call never dedup against each other; a feed
 *    that states its ids are bank references never loses a new id to a stored
 *    row of the same feed, booked or not;
 *  - the protection that must survive: the same statement twice, a bank file
 *    then the feed, a provider switch where every id changes once, a provider
 *    that regenerates its ids;
 *  - that the preview and the commit agree row by row, and that every skipped
 *    row is named with its reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ingestTransactions } from '../ingest'
import { previewIngestDedup } from '../dedup-preview'
import { buildStableExternalIds } from '../external-id'
import type { IngestOptions, RawTransaction } from '@/types'
import { createIngestFakeDb, FAKE_COMPANY_ID, type FakeRow, type IngestFakeDb } from '@/tests/ingest-fake-db'

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

const COMPANY_ID = FAKE_COMPANY_ID
const USER_ID = 'user-1'
type Row = FakeRow
const createFakeDb = createIngestFakeDb

// ---------------------------------------------------------------------------
// Fixtures: one bank account, one recurring fee
// ---------------------------------------------------------------------------

const DAY = '2025-03-10'
/** A feed that keys every row on the bank's own booking reference. */
const FEED = 'bank_api_feed'
const FEE = { date: DAY, description: 'Transaktionsavgift', amount: -12.5, currency: 'SEK' }

const feedFee = (externalId: string, overrides: Partial<RawTransaction> = {}): RawTransaction => ({
  ...FEE,
  external_id: externalId,
  import_source: FEED,
  ...overrides,
})

const STABLE: IngestOptions = { stableExternalIds: true }

function ingest(db: IngestFakeDb, rows: RawTransaction[], options?: IngestOptions) {
  return ingestTransactions(db.supabase as never, COMPANY_ID, USER_ID, rows, options)
}

const externalIds = (rows: Row[]) => rows.map((row) => row.external_id)

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe('identical rows that are separate movements', () => {
  it('imports every identical row that arrives in one call (rows of a call never dedup against each other)', async () => {
    const db = createFakeDb()

    const result = await ingest(db, [feedFee('ref-1'), feedFee('ref-2'), feedFee('ref-3')])

    expect(result.imported).toBe(3)
    expect(result.duplicates).toBe(0)
    expect(result.skipped).toEqual([])
    expect(externalIds(db.stored())).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })

  // The report, loud shape: two fees stored and booked, a third arrives alone
  // a day later under a bank reference never seen before.
  it('imports a third fee with its own bank reference when the two stored twins are BOOKED', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('ref-1'), feedFee('ref-2')], STABLE)
    db.book('ref-1', 'ref-2')

    const result = await ingest(db, [feedFee('ref-3')], STABLE)

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(0)
    expect(result.skipped).toEqual([])
    expect(externalIds(db.stored())).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })

  // The report, silent shape: the stored twins are still unbooked.
  it('imports a third fee with its own bank reference when the two stored twins are UNBOOKED', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('ref-1'), feedFee('ref-2')], STABLE)

    const result = await ingest(db, [feedFee('ref-3')], STABLE)

    expect(result.imported).toBe(1)
    expect(result.skipped).toEqual([])
    expect(externalIds(db.stored())).toEqual(['ref-1', 'ref-2', 'ref-3'])
  })

  it('still recognises a re-delivered booking by its id, and imports only the new one', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('ref-1'), feedFee('ref-2')], STABLE)
    db.book('ref-1')

    // The bank re-sends the whole day: two known references, one new.
    const result = await ingest(db, [feedFee('ref-1'), feedFee('ref-2'), feedFee('ref-3')], STABLE)

    expect(result.imported).toBe(1)
    expect(result.duplicates_by_reason).toEqual({
      external_id_match: 2,
      content_match_booked: 0,
      content_match_unbooked: 0,
    })
    expect(result.skipped?.map((row) => [row.external_id, row.reason])).toEqual([
      ['ref-1', 'external_id_match'],
      ['ref-2', 'external_id_match'],
    ])
    expect(db.stored()).toHaveLength(3)
  })

  it('never re-keys a bank reference, even one shaped like a content-derived id', async () => {
    // "<scope>_<date>_<öre>_<n>" is the shape of the occurrence-index ids that
    // get re-keyed against stored rows by description. A bank reference that
    // happens to look like one is still an identity.
    const db = createFakeDb()
    await ingest(db, [feedFee(`acct_${DAY}_-1250_0`)], STABLE)

    const result = await ingest(db, [feedFee(`acct_${DAY}_-1250_1`)], STABLE)

    expect(result.imported).toBe(1)
    expect(externalIds(db.stored())).toEqual([`acct_${DAY}_-1250_0`, `acct_${DAY}_-1250_1`])
  })

  // The date-drift shadow measures rows an enforcing rule WOULD drop as a
  // copy of a twin one day away. Yesterday's fee under another bank reference
  // is not such a twin; counting it would argue for a rule that loses it.
  it('keeps the daily fee of the next day out of the date-drift measurement', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('ref-1')], STABLE)

    // The batch spans both days, so yesterday's stored fee is in view.
    const result = await ingest(db, [
      feedFee('ref-other', { description: 'Annat köp', amount: -77 }),
      feedFee('ref-2', { date: '2025-03-11' }),
    ], STABLE)

    expect(result.imported).toBe(2)
    expect(result.shadow_date_drift_candidates).toBe(0)
    expect(result.shadow_scope_drift_candidates).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Without the statement, a later identical row is still absorbed: but never
// silently. This is the old behaviour, kept for ids that are not identities,
// and it is the control for the tests above (same steps, no statement).
// ---------------------------------------------------------------------------

describe('a feed that has not said its ids are bank references', () => {
  it('absorbs a later identical row into a BOOKED twin and names it in the result', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('ref-1'), feedFee('ref-2')])
    db.book('ref-1', 'ref-2')

    const result = await ingest(db, [feedFee('ref-3')])

    expect(result.imported).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.duplicates_by_reason).toEqual({
      external_id_match: 0,
      content_match_booked: 1,
      content_match_unbooked: 0,
    })
    expect(result.skipped).toEqual([
      {
        external_id: 'ref-3',
        reason: 'content_match_booked',
        matched_external_id: 'ref-1',
        matched_transaction_id: db.byExternalId('ref-1')!.id,
      },
    ])
    expect(db.stored()).toHaveLength(2)
  })

  it('absorbs a later identical row into an UNBOOKED twin and names it in the result', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('ref-1'), feedFee('ref-2')])

    const result = await ingest(db, [feedFee('ref-3')])

    expect(result.imported).toBe(0)
    expect(result.skipped).toEqual([
      {
        external_id: 'ref-3',
        reason: 'content_match_unbooked',
        matched_external_id: 'ref-1',
        matched_transaction_id: db.byExternalId('ref-1')!.id,
      },
    ])
  })

  it('does nothing with the statement when the rows carry no feed label (no id namespace)', async () => {
    const db = createFakeDb()
    const unlabelled = (externalId: string) => feedFee(externalId, { import_source: undefined })
    await ingest(db, [unlabelled('ref-1')], STABLE)
    db.book('ref-1')

    const result = await ingest(db, [unlabelled('ref-2')], STABLE)

    expect(result.imported).toBe(0)
    expect(result.skipped?.[0]).toMatchObject({ external_id: 'ref-2', reason: 'content_match_booked' })
  })
})

// ---------------------------------------------------------------------------
// The protection against real duplicates must survive
// ---------------------------------------------------------------------------

describe('re-imports are still skipped', () => {
  const CSV = 'csv_testbank'
  const csvFee = (externalId: string, overrides: Partial<RawTransaction> = {}): RawTransaction =>
    feedFee(externalId, { import_source: CSV, ...overrides })

  it('skips the same statement imported twice, also when the rows moved and every id is new', async () => {
    const db = createFakeDb()
    // File ids are hashes of the row position: a wider export of the same
    // period gives the same three fees three new ids.
    await ingest(db, [csvFee('csv-a1'), csvFee('csv-a2'), csvFee('csv-a3')])

    const again = await ingest(db, [csvFee('csv-b1'), csvFee('csv-b2'), csvFee('csv-b3')])

    expect(again.imported).toBe(0)
    expect(again.duplicates_by_reason).toMatchObject({ content_match_unbooked: 3 })
    expect(db.stored()).toHaveLength(3)
  })

  it('counts: a later statement with one more identical row imports exactly that one', async () => {
    const db = createFakeDb()
    await ingest(db, [csvFee('csv-a1'), csvFee('csv-a2')])

    const later = await ingest(db, [csvFee('csv-b1'), csvFee('csv-b2'), csvFee('csv-b3')])

    expect(later.imported).toBe(1)
    expect(later.duplicates).toBe(2)
    expect(db.stored()).toHaveLength(3)
  })

  it('skips the feed after a bank file of the same period, although the feed states stable ids', async () => {
    const db = createFakeDb()
    await ingest(db, [csvFee('csv-1'), csvFee('csv-2')])
    db.book('csv-1')

    // Another channel named these rows: the ids say nothing about them.
    const feed = await ingest(db, [feedFee('ref-1'), feedFee('ref-2')], STABLE)

    expect(feed.imported).toBe(0)
    expect(feed.duplicates_by_reason).toEqual({
      external_id_match: 0,
      content_match_booked: 1,
      content_match_unbooked: 1,
    })
    expect(db.stored()).toHaveLength(2)
  })

  it('skips the feed after a bank file when the two channels word the row differently (count mirror)', async () => {
    const db = createFakeDb()
    await ingest(db, [csvFee('csv-1', { description: 'BANKEN AB' }), csvFee('csv-2', { description: 'BANKEN AB' })])

    const feed = await ingest(db, [feedFee('ref-1'), feedFee('ref-2')], STABLE)

    expect(feed.imported).toBe(0)
    expect(db.stored()).toHaveLength(2)
  })

  it('skips a feed whose provider regenerated its ids (no statement: the ids are not identities)', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('old-1'), feedFee('old-2'), feedFee('old-3', { description: 'Hyra mars', amount: -9000 })])
    db.book('old-1')

    const resync = await ingest(db, [
      feedFee('new-1'),
      feedFee('new-2'),
      feedFee('new-3', { description: 'Hyra mars', amount: -9000 }),
    ])

    expect(resync.imported).toBe(0)
    expect(resync.duplicates).toBe(3)
    expect(db.stored()).toHaveLength(3)
  })

  // A provider's ids are often minted per consent. "The same feed" is the
  // label AND the bank connection, so the statement only has to hold within
  // one connection: across a reconnect the rows dedup on content again.
  it('skips a reconnected feed that minted new ids, although it states stable ids', async () => {
    const db = createFakeDb()
    const onConnection = (externalId: string, connection: string, date = DAY) =>
      feedFee(externalId, { bank_connection_id: connection, date })
    await ingest(db, [onConnection('old-1', 'conn-1'), onConnection('old-2', 'conn-1')], STABLE)
    db.book('old-1')

    const reconnected = await ingest(db, [onConnection('new-1', 'conn-2'), onConnection('new-2', 'conn-2')], STABLE)

    expect(reconnected.imported).toBe(0)
    expect(reconnected.duplicates).toBe(2)
    expect(db.stored()).toHaveLength(2)

    // Within the new connection the ids are identities again.
    const nextDay = '2025-03-11'
    await ingest(db, [onConnection('new-3', 'conn-2', nextDay), onConnection('new-4', 'conn-2', nextDay)], STABLE)
    const later = await ingest(db, [onConnection('new-5', 'conn-2', nextDay)], STABLE)
    expect(later.imported).toBe(1)
    expect(db.stored()).toHaveLength(5)
  })

  it('skips the re-delivery after the old connection was deleted (its rows keep no connection)', async () => {
    const db = createFakeDb()
    await ingest(db, [feedFee('old-1', { bank_connection_id: 'conn-1' }), feedFee('old-2', { bank_connection_id: 'conn-1' })], STABLE)
    // transactions.bank_connection_id is ON DELETE SET NULL.
    for (const row of db.stored()) row.bank_connection_id = null

    const reconnected = await ingest(db, [feedFee('new-1', { bank_connection_id: 'conn-2' }), feedFee('new-2', { bank_connection_id: 'conn-2' })], STABLE)

    expect(reconnected.imported).toBe(0)
    expect(db.stored()).toHaveLength(2)
  })

  it('lets a stored row of the same feed WITHOUT an id absorb an incoming row (nothing says it is another booking)', async () => {
    const db = createFakeDb()
    db.seed({ ...FEE, import_source: FEED, external_id: null })

    const result = await ingest(db, [feedFee('ref-1')], STABLE)

    expect(result.imported).toBe(0)
    expect(result.skipped).toEqual([
      {
        external_id: 'ref-1',
        reason: 'content_match_unbooked',
        matched_external_id: null,
        matched_transaction_id: db.stored()[0].id,
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// Known limit, pinned so it is not mistaken for covered
// ---------------------------------------------------------------------------

describe('known limit: twins that came through another channel', () => {
  // A bank file stored two fees. The feed's copies of those two were absorbed
  // by them and, being skipped, left no trace. A third fee then arrives alone:
  // nothing stored says the file's two rows are already spoken for, so one of
  // them absorbs it. Closing this needs the absorbed id to be remembered on
  // the stored row (see DECISIONS.md 2026-10-11). Until then the row is at
  // least named, with the stored row it matched.
  it('absorbs a new stable-id row that arrives alone, and names it', async () => {
    const db = createFakeDb()
    await ingest(db, [
      feedFee('csv-1', { import_source: 'csv_testbank' }),
      feedFee('csv-2', { import_source: 'csv_testbank' }),
    ])
    await ingest(db, [feedFee('ref-1'), feedFee('ref-2')], STABLE) // both absorbed

    const third = await ingest(db, [feedFee('ref-3')], STABLE)

    expect(third.imported).toBe(0)
    expect(third.skipped).toEqual([
      {
        external_id: 'ref-3',
        reason: 'content_match_unbooked',
        matched_external_id: 'csv-1',
        matched_transaction_id: db.byExternalId('csv-1')!.id,
      },
    ])
  })

  // The same three rows in ONE call are counted correctly: two stored twins
  // absorb two, the third is imported.
  it('imports the third when the feed delivers all three together', async () => {
    const db = createFakeDb()
    await ingest(db, [
      feedFee('csv-1', { import_source: 'csv_testbank' }),
      feedFee('csv-2', { import_source: 'csv_testbank' }),
    ])

    const all = await ingest(db, [feedFee('ref-1'), feedFee('ref-2'), feedFee('ref-3')], STABLE)

    expect(all.imported).toBe(1)
    expect(all.duplicates).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// The provider switch: every company's feed ids change once
// ---------------------------------------------------------------------------

describe('switching the bank feed to another provider', () => {
  const OLD = 'enable_banking'
  const NEW = 'new_bank_feed'
  const ACCOUNT = { id: 'cash-1930', company_id: COMPANY_ID, ledger_account: '1930', iban: 'SE0000000000000000000001', currency: 'SEK', enabled: true }
  const options: IngestOptions = { settlementAccount: '1930', stableExternalIds: true }

  /** The old provider's ids, in their stored format: scope, date, öre, occurrence. */
  const oldId = (date: string, amount: number, n: number) =>
    buildStableExternalIds('eb', 'SE0000000000000000000001', Array.from({ length: n + 1 }, () => ({ date, amount })))[n]

  /** What the old provider left behind: a few days of rows, some booked. */
  function seedOldFeed(db: IngestFakeDb) {
    db.tables.cash_accounts.push(ACCOUNT)
    const old = (n: number, row: { date: string; description: string; amount: number }) =>
      db.seed({ ...row, import_source: OLD, external_id: oldId(row.date, row.amount, n), cash_account_id: ACCOUNT.id, bank_connection_id: 'conn-old' })
    old(0, { ...FEE })
    old(1, { ...FEE })
    old(0, { date: DAY, description: 'Hyra mars Fastighets AB', amount: -9000 })
    old(0, { date: '2025-03-11', description: 'Kund AB faktura 1042', amount: 25000 })
    old(0, { date: '2025-03-12', description: 'Kortköp MATBUTIK', amount: -349.5 })
    db.book(oldId(DAY, FEE.amount, 0), oldId(DAY, -9000, 0))
  }

  /** The same month as the new provider reports it: new ids, same bookings. */
  const newFeedRows = (): RawTransaction[] => [
    { ...FEE, external_id: 'np-fee-1', import_source: NEW, bank_connection_id: 'conn-new' },
    { ...FEE, external_id: 'np-fee-2', import_source: NEW, bank_connection_id: 'conn-new' },
    { date: DAY, description: 'Hyra mars Fastighets AB', amount: -9000, currency: 'SEK', external_id: 'np-rent', import_source: NEW, bank_connection_id: 'conn-new' },
    { date: '2025-03-11', description: 'Kund AB faktura 1042', amount: 25000, currency: 'SEK', external_id: 'np-invoice', import_source: NEW, bank_connection_id: 'conn-new' },
    { date: '2025-03-12', description: 'Kortköp MATBUTIK', amount: -349.5, currency: 'SEK', external_id: 'np-card', import_source: NEW, bank_connection_id: 'conn-new' },
  ]

  it('imports nothing when the new provider re-delivers what the old one stored, although it states stable ids', async () => {
    const db = createFakeDb()
    seedOldFeed(db)

    const first = await ingest(db, newFeedRows(), options)

    expect(first.imported).toBe(0)
    expect(first.duplicates).toBe(5)
    expect(first.duplicates_by_reason).toEqual({
      external_id_match: 0,
      content_match_booked: 2,
      content_match_unbooked: 3,
    })
    expect(db.stored()).toHaveLength(5)

    // And the night after: the same window again, still nothing new.
    const second = await ingest(db, newFeedRows(), options)

    expect(second.imported).toBe(0)
    expect(db.stored()).toHaveLength(5)
  })

  // The bank connection is part of "the same feed", so the switch is covered
  // even if the new adapter kept the old label. (It should still take its own:
  // only rows from a DIFFERENT label get the count mirror, which is what
  // covers rows the two providers word differently.)
  it('imports nothing when the new adapter reuses the old label on a new connection', async () => {
    const db = createFakeDb()
    seedOldFeed(db)
    const relabelled = newFeedRows().map((row) => ({ ...row, import_source: OLD }))

    const first = await ingest(db, relabelled, options)

    expect(first.imported).toBe(0)
    expect(first.duplicates).toBe(5)
    expect(db.stored()).toHaveLength(5)
  })

  it('imports nothing when the new provider makes no statement about its ids', async () => {
    const db = createFakeDb()
    seedOldFeed(db)

    const first = await ingest(db, newFeedRows(), { settlementAccount: '1930' })

    expect(first.imported).toBe(0)
    expect(db.stored()).toHaveLength(5)
  })

  it('imports exactly the one movement the old provider never delivered', async () => {
    const db = createFakeDb()
    seedOldFeed(db)
    const lateFee: RawTransaction = { ...FEE, external_id: 'np-fee-3', import_source: NEW, bank_connection_id: 'conn-new' }

    const first = await ingest(db, [...newFeedRows(), lateFee], options)

    expect(first.imported).toBe(1)
    expect(first.duplicates).toBe(5)
    expect(db.stored()).toHaveLength(6)

    // Re-delivered the next night: the stored new-provider row is an id
    // match, the other two fees still find the old provider's two rows.
    const second = await ingest(db, [...newFeedRows(), lateFee], options)

    expect(second.imported).toBe(0)
    expect(second.duplicates_by_reason).toMatchObject({ external_id_match: 1 })
    expect(db.stored()).toHaveLength(6)
  })

  it('imports a new booking after the switch although identical rows of the NEW provider are stored', async () => {
    const db = createFakeDb()
    db.tables.cash_accounts.push(ACCOUNT)
    const fee = (externalId: string): RawTransaction => ({ ...FEE, external_id: externalId, import_source: NEW, bank_connection_id: 'conn-new' })
    await ingest(db, [fee('np-fee-1'), fee('np-fee-2')], options)
    db.book('np-fee-1', 'np-fee-2')

    const result = await ingest(db, [fee('np-fee-3')], options)

    expect(result.imported).toBe(1)
    expect(db.stored()).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// The preview predicts the commit, row by row
// ---------------------------------------------------------------------------

describe('the dry-run and the commit agree', () => {
  const ACCOUNT = { id: 'cash-1930', company_id: COMPANY_ID, ledger_account: '1930', iban: 'SE0000000000000000000001', currency: 'SEK', enabled: true }
  const OTHER_ACCOUNT = { id: 'cash-1940', company_id: COMPANY_ID, ledger_account: '1940', iban: 'SE0000000000000000000002', currency: 'SEK', enabled: true }

  /** Stored state that exercises every path of the decision. */
  function seedMixed(db: IngestFakeDb) {
    db.tables.cash_accounts.push(ACCOUNT, OTHER_ACCOUNT)
    const on1930 = { cash_account_id: ACCOUNT.id }
    // The feed's own earlier rows: one booked, one not.
    db.seed({ ...FEE, import_source: FEED, external_id: 'ref-1', journal_entry_id: 'je-1', ...on1930 })
    db.seed({ ...FEE, import_source: FEED, external_id: 'ref-2', ...on1930 })
    // A bank file's rows: one that bridges by text, one that only mirrors.
    db.seed({ date: DAY, description: 'Hyra mars', amount: -9000, import_source: 'csv_testbank', external_id: 'csv-rent', journal_entry_id: 'je-2', ...on1930 })
    db.seed({ date: '2025-03-11', description: 'BOLAGET AB', amount: -700, import_source: 'csv_testbank', external_id: 'csv-payee', ...on1930 })
    // A movement the user booked by hand before the feed delivered it.
    db.seed({ date: '2025-03-12', description: 'Egen insättning', amount: 5000, import_source: 'mcp', external_id: null, journal_entry_id: 'je-3' })
    // Same day, amount and text, but another currency and another account.
    db.seed({ date: '2025-03-13', description: 'Leverantör X', amount: -250, currency: 'EUR', import_source: 'csv_testbank', external_id: 'csv-eur', ...on1930 })
    db.seed({ date: '2025-03-14', description: 'Leverantör Y', amount: -480, import_source: 'csv_testbank', external_id: 'csv-other-account', cash_account_id: OTHER_ACCOUNT.id })
  }

  const batch = (): RawTransaction[] => [
    feedFee('ref-2'), // stored under this id
    feedFee('ref-3'), // new reference, identical to two stored rows of this feed
    feedFee('ref-rent', { description: 'Hyra mars Fastighets AB', amount: -9000 }), // bridges a booked file row
    feedFee('ref-payee', { date: '2025-03-11', description: 'OCR 55512', amount: -700 }), // mirrors a file row
    feedFee('ref-deposit', { date: '2025-03-12', description: 'Insättning 4411', amount: 5000 }), // mirrors a hand booking
    feedFee('ref-sek', { date: '2025-03-13', description: 'Leverantör X', amount: -250 }), // EUR twin: not the same
    feedFee('ref-1930', { date: '2025-03-14', description: 'Leverantör Y', amount: -480 }), // twin on another account
    feedFee('ref-new', { date: '2025-03-15', description: 'Nytt köp', amount: -99 }), // nothing like it stored
  ]

  it.each([
    ['the feed states stable ids', { settlementAccount: '1930', stableExternalIds: true }, ['ref-3', 'ref-sek', 'ref-1930', 'ref-new']],
    ['the feed makes no statement', { settlementAccount: '1930' }, ['ref-sek', 'ref-1930', 'ref-new']],
    ['no settlement account is given', { stableExternalIds: true }, ['ref-3', 'ref-sek', 'ref-new']],
  ] as const)('row by row when %s', async (_name, options, expectedImports) => {
    const db = createFakeDb()
    seedMixed(db)
    const before = JSON.stringify(db.tables)

    const preview = await previewIngestDedup(db.supabase as never, COMPANY_ID, batch(), options)

    // The preview is read-only.
    expect(db.writes).toEqual([])
    expect(JSON.stringify(db.tables)).toBe(before)

    const result = await ingest(db, batch(), { ...options })

    // Every row the preview said would be imported was inserted, and no other.
    const wouldImport = preview.filter((row) => !row.would_skip).map((row) => row.external_id)
    const inserted = db.stored().filter((row) => result.transaction_ids.includes(String(row.id))).map((row) => row.external_id)
    expect(wouldImport).toEqual([...expectedImports])
    expect(inserted).toEqual(wouldImport)
    expect(result.imported).toBe(wouldImport.length)
    expect(result.errors).toBe(0)

    // Every row the preview said would be skipped was skipped, for the same
    // reason, against the same stored row.
    const wouldSkip = preview
      .filter((row) => row.would_skip)
      .map((row) => ({
        external_id: row.external_id,
        reason: row.skip_reason,
        matched_external_id: row.matched_external_id,
        matched_transaction_id: row.matched_transaction_id,
      }))
    expect(result.skipped).toEqual(wouldSkip)
    expect(result.duplicates).toBe(wouldSkip.length)

    // Nothing is unaccounted for: imported + skipped = sent.
    expect(result.imported + result.duplicates).toBe(batch().length)
  })

  it('names every reason once in the mixed batch', async () => {
    const db = createFakeDb()
    seedMixed(db)

    const preview = await previewIngestDedup(db.supabase as never, COMPANY_ID, batch(), { settlementAccount: '1930', stableExternalIds: true })

    expect(preview.map((row) => [row.external_id, row.skip_reason, row.matched_external_id])).toEqual([
      ['ref-2', 'external_id_match', 'ref-2'],
      ['ref-3', null, null],
      ['ref-rent', 'content_match_booked', 'csv-rent'],
      ['ref-payee', 'content_match_unbooked', 'csv-payee'],
      ['ref-deposit', 'content_match_booked', null],
      ['ref-sek', null, null],
      ['ref-1930', null, null],
      ['ref-new', null, null],
    ])
  })

  it('returns an empty preview for an empty batch without reading', async () => {
    const db = createFakeDb()

    expect(await previewIngestDedup(db.supabase as never, COMPANY_ID, [])).toEqual([])
    expect(db.supabase.from).not.toHaveBeenCalled()
  })
})
