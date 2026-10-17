/**
 * gnubok_bulk_book_transactions: the two per-batch homogeneity refusals are
 * legal limits (BFL 5 kap 6 § tredje stycket: one gemensam verifikation only
 * for likartade affärshändelser on the same day). Read as technical limits
 * they led an agent to propose a monthly samlingsverifikat (feedback seq
 * 378710 / 382660), so the message must cite the statute and the split, and
 * carry the registry code so the envelope resolves to a remediation.
 *
 * The tool is generated from the operation transactions.bulk-book: the
 * staging dry run (lib/transactions/bulk-book.ts) answers the RPC's refusals
 * the rows already show, and the binding's refusal hook words them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import {
  detectBookingDuplicate,
  type BookedDuplicateCandidate,
} from '@/lib/transactions/booking-duplicate-detection'
import { tools } from '../server'

vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()
  return { ...actual, detectBookingDuplicate: vi.fn() }
})

const bulkBook = tools.find((t) => t.name === 'gnubok_bulk_book_transactions')!

const TX_1 = '11111111-1111-4111-8111-111111111111'
const TX_2 = '22222222-2222-4222-8222-222222222222'
const JE_1 = '33333333-3333-4333-8333-333333333333'

async function stage(txRows: Array<Record<string, unknown>>, body: Record<string, unknown> = { existing_journal_entry_id: JE_1 }) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: txRows, error: null }) // transactions fetch: the first query
  return bulkBook.execute(
    { tx_ids: txRows.map((t) => t.id), ...body },
    'company-1',
    'user-1',
    supabase as never,
  )
}

/** A new samlingsverifikat: the path the one-day rule applies to. */
const NEW_ENTRY = {
  entry_description: 'Kortavgifter',
  manual_lines: [
    { account_number: '6570', debit_amount: 300, credit_amount: 0, currency: 'SEK' },
    { account_number: '1930', debit_amount: 0, credit_amount: 300, currency: 'SEK' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_bulk_book_transactions: BFL 5 kap 6 § refusals', () => {
  it('cites the statute and the per-day split when the dates of a new samlingsverifikat differ', async () => {
    const err = await stage(
      [
        { id: TX_1, amount: -100, currency: 'SEK', date: '2026-05-12', journal_entry_id: null },
        { id: TX_2, amount: -200, currency: 'SEK', date: '2026-05-13', journal_entry_id: null },
      ],
      NEW_ENTRY,
    ).catch((e: unknown) => e as Error & { code?: string })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('BFL 5 kap 6')
    expect((err as Error).message).toMatch(/likartade affärshändelser on the same day/)
    expect((err as Error).message).toMatch(/once per date/)
    // ...and names the one way rows of several days share a verifikat.
    expect((err as Error).message).toMatch(/link them with existing_journal_entry_id/)
    expect((err as Error & { code?: string }).code).toBe('BULK_BOOK_DATE_MISMATCH')
  })

  it('cites the statute and the per-direction split when signs differ', async () => {
    const err = await stage([
      { id: TX_1, amount: -100, currency: 'SEK', date: '2026-05-12', journal_entry_id: null },
      { id: TX_2, amount: 250, currency: 'SEK', date: '2026-05-12', journal_entry_id: null },
    ]).catch((e: unknown) => e as Error & { code?: string })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('BFL 5 kap 6')
    expect((err as Error).message).toMatch(/once for the income rows and once for the expense rows/)
    expect((err as Error & { code?: string }).code).toBe('BULK_BOOK_DIRECTION_MISMATCH')
  })
})

/**
 * The booking-time duplicate guard the dashboard and v1 bulk-book doors run
 * (runBulkBookDuplicateGuard): a bank line the ledger already books, e.g. a
 * supplier invoice marked paid, is refused at stage with the same code
 * instead of being queued for a second verifikat. force is the override
 * (allow_duplicate on the hand-written tool), staged with the operation so
 * the approval honours it and records the dismissal.
 */
describe('gnubok_bulk_book_transactions: duplicate-booking guard at stage', () => {
  const ROW = {
    id: TX_1,
    amount: -1250,
    currency: 'SEK',
    date: '2026-05-12',
    journal_entry_id: null,
    description: 'BG 5050-1055',
    merchant_name: null,
    amount_sek: null,
    exchange_rate: null,
    cash_account_id: null,
  }
  const CANDIDATE: BookedDuplicateCandidate = {
    transaction_id: null,
    journal_entry_id: 'je-paid',
    voucher_label: 'A142',
    entry_date: '2026-05-12',
    description: 'Leverantörsfaktura betald',
    amount: 1250,
    account_number: '1930',
    currency: null,
    amount_in_currency: null,
    amount_verified: true,
    unverified_reason: null,
  }

  it('refuses a bank line the ledger already books, before staging', async () => {
    vi.mocked(detectBookingDuplicate).mockResolvedValueOnce(CANDIDATE)
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [ROW], error: null }) // transactions fetch

    const err = await bulkBook
      .execute({ tx_ids: [TX_1], existing_journal_entry_id: JE_1 }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect((err as Error).message).toContain('verifikat A142')
    expect((err as Error).message).toContain('force=true')
    // The batch's own rows and the link target never count as the duplicate.
    expect(detectBookingDuplicate).toHaveBeenCalledWith(
      supabase,
      'company-1',
      expect.objectContaining({ id: TX_1, amount: -1250, date: '2026-05-12' }),
      { excludeTransactionIds: [TX_1], excludeJournalEntryIds: [JE_1] },
    )
    expect(findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('stages with force=true and carries the override to the approval', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [ROW], error: null }) // transactions fetch
    enqueue({ data: { id: JE_1, entry_date: '2026-05-12', status: 'posted' }, error: null }) // link target
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
    enqueue({ data: null, error: null })
    enqueue({ data: [], error: null }) // open operations on these rows: none (crm#1264)
    enqueue({ data: { id: 'op-dup' }, error: null }) // pending_operations insert

    await bulkBook.execute(
      { tx_ids: [TX_1], existing_journal_entry_id: JE_1, force: true },
      'company-1',
      'user-1',
      supabase as never,
    )

    // Staging writes nothing, so the override needs no detection here: the
    // approval re-detects and records the dismissal.
    expect(detectBookingDuplicate).not.toHaveBeenCalled()
    const inserts = findCalls('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect((inserts[0]![0] as { params: Record<string, unknown> }).params).toEqual({
      tx_ids: [TX_1],
      existing_journal_entry_id: JE_1,
      force: true,
    })
  })

  it('refuses a link target that is not posted, before staging', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [ROW], error: null }) // transactions fetch
    enqueue({ data: { id: JE_1, entry_date: '2026-05-12', status: 'draft' }, error: null }) // link target

    const err = await bulkBook
      .execute({ tx_ids: [TX_1], existing_journal_entry_id: JE_1 }, 'company-1', 'user-1', supabase as never)
      .catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('BULK_BOOK_VOUCHER_NOT_POSTED')
    expect(findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('refuses a foreign-currency batch the approval could never post (the hand-written tool staged it)', async () => {
    const err = await stage([
      { id: TX_1, amount: -100, currency: 'EUR', date: '2026-05-12', journal_entry_id: null },
    ]).catch((e: unknown) => e)
    expect(getStructuredError(err).code).toBe('BULK_BOOK_FOREIGN_CURRENCY')
  })
})
