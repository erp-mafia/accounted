/**
 * A bank entry the bank re-dates between two reads (crm#2024).
 *
 * The bank-feed key carries the booking date ({scope}_{date}_{öre}_{n}), so an
 * entry the bank dates one day later on a later read used to get a new key
 * and land in the inbox a second time, next to the row the user had already
 * booked. The bank's own id (provider_transaction_id) is the same on both
 * reads; ingest now pairs the re-read with its stored row by that id. These
 * run the real pipeline against in-memory tables (tests/ingest-fake-db.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ingestTransactions } from '../ingest'
import { previewIngestDedup } from '../dedup-preview'
import { buildStableExternalIds } from '../external-id'
import type { RawTransaction } from '@/types'
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

const SCOPE = 'SE0000000000000000000001'
const CONNECTION = 'bc-lunar'

interface Entry {
  bankId: string
  date: string
  amount: number
  description: string
  balanceAfter: number
}

/** One read of the account as the Open Payments sync maps it (lib/bank-feed/sync.ts). */
function read(entries: Entry[]): RawTransaction[] {
  const ids = buildStableExternalIds('eb', SCOPE, entries.map((e) => ({ date: e.date, amount: e.amount })))
  return entries.map((e, i) => ({
    date: e.date,
    value_date: e.date,
    description: e.description,
    amount: e.amount,
    currency: 'SEK',
    external_id: ids[i]!,
    provider_transaction_id: e.bankId,
    balance_after: e.balanceAfter,
    bank_connection_id: CONNECTION,
    import_source: 'open_payments',
  }))
}

const ingest = (db: IngestFakeDb, rows: RawTransaction[]) =>
  ingestTransactions(db.supabase as never, FAKE_COMPANY_ID, 'user-1', rows)

// The observed shape, with made-up amounts: a payment and its fee booked on the 15th on
// the first read, the same two entries (same ids, same balance after) on the
// 16th on a later one, beside fees that kept their day and a new fee.
const fee = (bankId: string, date: string, balanceAfter: number): Entry =>
  ({ bankId, date, amount: -0.99, description: 'Fee', balanceAfter })
const firstRead: Entry[] = [
  fee('fee-1', '2026-11-15', 8749),
  { bankId: 'pay-1', date: '2026-11-15', amount: -1250, description: 'Överföring', balanceAfter: 8750 },
  fee('fee-2', '2026-11-15', 10000.99),
  fee('fee-3', '2026-11-15', 10001.98),
]
const laterRead: Entry[] = [
  fee('fee-4', '2026-11-16', 8748.01),
  fee('fee-1', '2026-11-16', 8749),
  { bankId: 'pay-1', date: '2026-11-16', amount: -1250, description: 'Överföring', balanceAfter: 8750 },
  fee('fee-2', '2026-11-15', 10000.99),
  fee('fee-3', '2026-11-15', 10001.98),
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a bank entry re-dated between two reads (crm#2024)', () => {
  it('skips the re-dated entries as the rows already stored, booked or not, and imports only the new fee', async () => {
    const db = createIngestFakeDb()
    expect((await ingest(db, read(firstRead))).imported).toBe(4)
    const [fee1, pay1] = db.stored()
    db.book(String(fee1.external_id), String(pay1.external_id))

    const result = await ingest(db, read(laterRead))

    expect(result.imported).toBe(1)
    expect(result.duplicates).toBe(4)
    expect(result.duplicates_by_reason).toMatchObject({ external_id_match: 4 })
    const byBankId = (bankId: string) => db.stored().filter((row) => row.provider_transaction_id === bankId)
    for (const bankId of ['fee-1', 'pay-1', 'fee-2', 'fee-3', 'fee-4']) {
      expect(byBankId(bankId)).toHaveLength(1)
    }
    // The stored rows keep their day and their verifikat.
    expect(byBankId('pay-1')[0]).toMatchObject({ date: '2026-11-15', journal_entry_id: `je-${String(pay1.id)}` })
    expect(byBankId('fee-1')[0]).toMatchObject({ date: '2026-11-15', journal_entry_id: `je-${String(fee1.id)}` })
    // Each re-read wrote to its own stored row: every fee keeps its own balance.
    expect(byBankId('fee-2')[0].balance_after).toBe(10000.99)
    expect(byBankId('fee-3')[0].balance_after).toBe(10001.98)
  })

  it('the preview says what the commit does', async () => {
    const db = createIngestFakeDb()
    await ingest(db, read(firstRead))
    const writesBefore = db.writes.length

    const preview = await previewIngestDedup(db.supabase as never, FAKE_COMPANY_ID, read(laterRead))

    expect(preview.map((row) => row.would_skip)).toEqual([false, true, true, true, true])
    expect(db.writes).toHaveLength(writesBefore)
  })

  it('keeps a real second payment with its own bank id on the next day', async () => {
    const db = createIngestFakeDb()
    await ingest(db, read(firstRead))

    const result = await ingest(db, read([
      { bankId: 'pay-2', date: '2026-11-16', amount: -1250, description: 'Överföring', balanceAfter: 7500 },
      ...firstRead,
    ]))

    expect(result.imported).toBe(1)
    expect(db.stored().filter((row) => row.amount === -1250)).toHaveLength(2)
  })
})
