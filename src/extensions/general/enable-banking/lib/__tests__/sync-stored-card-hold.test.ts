/**
 * A Nordea card hold stored before the sync left holds out (crm#2076).
 *
 * From 2026-11-20 Nordea listed card holds among its booked entries and the
 * sync imported them; those rows are still stored (ignored or not). The sync
 * now leaves the holds out of the read, so a stored hold no longer takes an
 * occurrence index, and a purchase Nordea books on the hold's day for the
 * hold's amount gets the id the hold is stored under. Ingest must store that
 * purchase, not skip it as the hold's duplicate.
 *
 * The real sync (conversion, the hold filter, the stable ids) feeds the real
 * ingest pipeline over in-memory tables (tests/ingest-fake-db.ts); only the
 * bank, the archive and the route read are stand-ins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIngestFakeDb, FAKE_COMPANY_ID, type IngestFakeDb } from '@/tests/ingest-fake-db'

const mockGetAllTransactionsWithRaw = vi.fn()
vi.mock('../api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api-client')>()),
  getAllTransactionsWithRaw: (...args: unknown[]) => mockGetAllTransactionsWithRaw(...args),
  getAccountBalance: vi.fn().mockRejectedValue(new Error('skip')),
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
}))
vi.mock('@/lib/bank-feed/page-arrival', () => ({ recordBankFeedPageArrival: vi.fn() }))
vi.mock('@/lib/bank-sync/ingest-route', () => ({
  resolveBankIngestRoute: vi.fn(async (_db: unknown, _company: string, connectionId: string, accountUid: string, currency: string) => ({
    connectionId, accountUid, currency, sessionId: 'session-1', cashAccountId: 'cash-1', ledgerAccount: '1930', token: 'route-token',
  })),
}))
// What ingest calls besides the tables, as in the other fake-db ingest tests.
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  evaluateMappingRules: vi.fn().mockResolvedValue({ confidence: 0, requires_review: true }),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({ createTransactionJournalEntry: vi.fn() }))
vi.mock('@/lib/invoices/invoice-matching', () => ({
  loadInvoiceMatchPool: vi.fn().mockResolvedValue({ invoices: [] }),
  bestInvoiceMatch: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/invoices/rot-rut-payout-candidates', () => ({
  loadOpenRotRutPayoutRequests: vi.fn().mockResolvedValue([]),
}))

import { syncAccountTransactions } from '../sync'
import { ingestTransactions } from '@/lib/transactions/ingest'

const CASH_ACCOUNT_ID = 'cash-1'
const CONNECTION_ID = 'conn-nordea'
const IBAN = 'SE0000000000000000000002'
const DAY = '2026-11-20'
const HOLD_ID = `eb_${IBAN}_${DAY}_-12900_0`
const HOLD_TEXT = 'Reservation Kortköp BOKHANDELN'
const PURCHASE_TEXT = 'Kortköp 261119 BOKHANDELN'

/** One booked entry as Nordea lists it through Enable Banking. */
const entry = (entryReference: string, text: string) => ({
  entry_reference: entryReference,
  status: 'BOOK',
  credit_debit_indicator: 'DBIT',
  transaction_amount: { amount: '129.00', currency: 'SEK' },
  booking_date: DAY,
  value_date: DAY,
  remittance_information: [text],
})
const holdEntry = entry('2026-11-20-09.41.07.120000', HOLD_TEXT)
const purchaseEntry = entry('2026-11-20-14.05.33.481216', PURCHASE_TEXT)

type InsertBuilder = {
  insert: (row: Record<string, unknown>) => { select: () => { single: () => PromiseLike<{ data: unknown; error: unknown }> } }
}

/** The account's cash account, and the hold an earlier sync stored. */
function nordeaBooks(holdIgnored: boolean): IngestFakeDb {
  const db = createIngestFakeDb()
  db.tables.cash_accounts.push({
    id: CASH_ACCOUNT_ID, company_id: FAKE_COMPANY_ID, ledger_account: '1930', iban: IBAN, currency: 'SEK',
    enabled: true, bank_connection_id: CONNECTION_ID,
  })
  db.seed({
    external_id: HOLD_ID, date: DAY, value_date: DAY, amount: -129, description: HOLD_TEXT,
    import_source: 'enable_banking', bank_connection_id: CONNECTION_ID, cash_account_id: CASH_ACCOUNT_ID,
    provider_transaction_id: holdEntry.entry_reference, is_ignored: holdIgnored,
  })
  // A bank-feed row goes in through the route-checked RPC; here it is the plain insert.
  const transactions = () => db.from('transactions') as unknown as InsertBuilder
  db.supabase.rpc.mockImplementation(async (name: string, args: { p_transaction: Record<string, unknown> }) =>
    name === 'insert_bank_transaction'
      ? await transactions().insert(args.p_transaction).select().single()
      : { data: null, error: null })
  return db
}

function sync(db: IngestFakeDb, bankName: string) {
  mockGetAllTransactionsWithRaw.mockResolvedValue({ transactions: [holdEntry, purchaseEntry], rawPages: ['{}'] })
  return syncAccountTransactions(
    db.supabase as never, FAKE_COMPANY_ID, 'user-1', CONNECTION_ID,
    { uid: 'acc-1', currency: 'SEK', iban: IBAN },
    '2026-11-13', DAY, ingestTransactions, { bankName },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("a Nordea card hold stored before the sync left holds out (crm#2076)", () => {
  it.each([true, false])('stores the purchase booked on its day for its amount (hold ignored: %s)', async (holdIgnored) => {
    const db = nordeaBooks(holdIgnored)

    const result = await sync(db, 'Nordea')

    expect(result).toMatchObject({ imported: 1, duplicates: 0, notBooked: 1 })
    expect(db.stored().map((row) => [row.external_id, row.original_description, row.provider_transaction_id])).toEqual([
      [HOLD_ID, HOLD_TEXT, holdEntry.entry_reference],
      [`eb_${IBAN}_${DAY}_-12900_1`, PURCHASE_TEXT, purchaseEntry.entry_reference],
    ])
    // The hold is left as it was.
    expect(db.byExternalId(HOLD_ID)).toMatchObject({ is_ignored: holdIgnored, journal_entry_id: null })
  })

  it('a later read of the purchase is its stored row, and the hold stays out', async () => {
    const db = nordeaBooks(true)
    await sync(db, 'Nordea')

    const again = await sync(db, 'Nordea')

    expect(again).toMatchObject({ imported: 0, duplicates: 1 })
    expect(db.stored()).toHaveLength(2)
  })
})
