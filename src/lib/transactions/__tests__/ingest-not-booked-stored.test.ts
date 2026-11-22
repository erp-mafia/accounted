/**
 * A stored row the feed reads as not booked (crm#2076).
 *
 * From 2026-11-20 Nordea listed card holds among its booked entries and the
 * Enable Banking sync stored them. The sync now leaves holds out of what it
 * sends, so a stored hold no longer takes an occurrence index in the read,
 * and a purchase booked on the hold's day for the hold's amount arrives under
 * the id the hold is stored under. Re-keying paired the two by that id alone
 * and Layer 1 skipped the purchase as the hold's duplicate; with the hold
 * ignored, the purchase never reached the books. The feed now says how it
 * reads a hold (IngestOptions.isNotBooked) and such a stored row takes no
 * incoming row. These run the real pipeline against in-memory tables
 * (tests/ingest-fake-db.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ingestTransactions } from '../ingest'
import { previewIngestDedup } from '../dedup-preview'
import { buildStableExternalIds } from '../external-id'
import type { IngestOptions, RawTransaction } from '@/types'
import { createIngestFakeDb, FAKE_COMPANY_ID, type IngestFakeDb } from '@/tests/ingest-fake-db'

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

const SCOPE = 'SE0000000000000000000002'
const CONNECTION = 'bc-nordea'
const DAY = '2026-11-20'
const HOLD = 'Reservation Kortköp BOKHANDELN'
const PURCHASE = 'Kortköp 261119 BOKHANDELN'
const id = (n: number) => `eb_${SCOPE}_${DAY}_-12900_${n}`

/** The feed's reading, standing in for the Enable Banking one (isNordeaCardHold). */
const FEED: IngestOptions = { isNotBooked: (text) => text.startsWith('Reservation ') }

/** One read of the account as the sync sends it: holds left out, ids built over the rest. */
function read(entries: Array<{ bankId: string; description: string }>): RawTransaction[] {
  const ids = buildStableExternalIds('eb', SCOPE, entries.map(() => ({ date: DAY, amount: -129 })))
  return entries.map((e, i) => ({
    date: DAY,
    value_date: DAY,
    description: e.description,
    amount: -129,
    currency: 'SEK',
    external_id: ids[i]!,
    provider_transaction_id: e.bankId,
    bank_connection_id: CONNECTION,
    import_source: 'enable_banking',
  }))
}

/** The hold as the sync stored it before it left holds out. */
function storedHold(db: IngestFakeDb, isIgnored: boolean) {
  db.seed({
    external_id: id(0), date: DAY, value_date: DAY, amount: -129, description: HOLD,
    provider_transaction_id: 'hold-1', bank_connection_id: CONNECTION, import_source: 'enable_banking', is_ignored: isIgnored,
  })
}

const ingest = (db: IngestFakeDb, rows: RawTransaction[], options?: IngestOptions) =>
  ingestTransactions(db.supabase as never, FAKE_COMPANY_ID, 'user-1', rows, options)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a stored row the feed reads as not booked (crm#2076)', () => {
  it.each([true, false])('stores the purchase booked on its day for its amount (hold ignored: %s)', async (isIgnored) => {
    const db = createIngestFakeDb()
    storedHold(db, isIgnored)

    const result = await ingest(db, read([{ bankId: 'pay-1', description: PURCHASE }]), FEED)

    expect(result).toMatchObject({ imported: 1, duplicates: 0 })
    expect(db.stored().map((row) => [row.external_id, row.original_description, row.is_ignored ?? null])).toEqual([
      [id(0), HOLD, isIgnored],
      [id(1), PURCHASE, null],
    ])
  })

  it('a later read of the purchase is its stored row, not a third one', async () => {
    const db = createIngestFakeDb()
    storedHold(db, true)
    await ingest(db, read([{ bankId: 'pay-1', description: PURCHASE }]), FEED)

    const again = await ingest(db, read([{ bankId: 'pay-1', description: PURCHASE }]), FEED)

    expect(again).toMatchObject({ imported: 0, duplicates: 1 })
    expect(again.skipped).toEqual([expect.objectContaining({ reason: 'external_id_match', matched_external_id: id(1) })])
    expect(db.stored()).toHaveLength(2)
  })

  it('a hold the other feed stored takes no purchase either: not by its id, not as a mirror twin', async () => {
    // A company moved from Enable Banking to Open Payments: both feeds key rows
    // in one eb_ namespace, and a row of the other feed counts for the
    // cross-channel mirror, which pairs on day and amount alone.
    const db = createIngestFakeDb()
    storedHold(db, true)
    const openPaymentsRead = read([{ bankId: 'pay-1', description: PURCHASE }]).map((row) => ({ ...row, import_source: 'open_payments' }))

    const result = await ingest(db, openPaymentsRead, FEED)

    expect(result).toMatchObject({ imported: 1, duplicates: 0 })
    expect(db.byExternalId(id(1))).toMatchObject({ import_source: 'open_payments', original_description: PURCHASE })
  })

  it('a hold the user has booked takes no purchase either', async () => {
    const db = createIngestFakeDb()
    storedHold(db, false)
    db.book(id(0))

    const result = await ingest(db, read([{ bankId: 'pay-1', description: PURCHASE }]), FEED)

    expect(result).toMatchObject({ imported: 1, duplicates: 0 })
    expect(db.byExternalId(id(1))).toMatchObject({ original_description: PURCHASE })
  })

  it('the preview says what the commit does', async () => {
    const db = createIngestFakeDb()
    storedHold(db, true)

    const preview = await previewIngestDedup(db.supabase as never, FAKE_COMPANY_ID, read([{ bankId: 'pay-1', description: PURCHASE }]), FEED)

    expect(preview.map((row) => row.would_skip)).toEqual([false])
  })

  it("without the feed's reading, the hold takes the purchase by its id alone, as any stored row does", async () => {
    const db = createIngestFakeDb()
    storedHold(db, true)

    const result = await ingest(db, read([{ bankId: 'pay-1', description: PURCHASE }]))

    expect(result).toMatchObject({ imported: 0, duplicates: 1 })
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'external_id_match', matched_external_id: id(0) })])
  })
})
