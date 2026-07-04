/**
 * Bulk-book Underlag (Modell B) core logic.
 *
 * `bulkBookMatchedInboxItems` is shared by the direct UI route
 * (POST /items/bulk-book) and the `bulk_book_inbox_items` pending-operation
 * executor. These tests pin the "Bokför valda hoppar över" contract: items
 * that aren't matched / already booked / linked to a leverantörsfaktura are
 * SKIPPED, never errored, and the happy path where a matched item is booked
 * against its transaction via the shared categorize core.
 *
 * The single-item categorize core itself (createJE, duplicate guard, VAT
 * mapping, underlag propagation) is covered by
 * lib/pending-operations/__tests__/commit-duplicate-guard.test.ts and the
 * inbox-link pg tests; here we mock its downstream modules and assert the
 * loop's classification + collection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreateJE = vi.fn()
const mockDetectDup = vi.fn()
const mockMapping = vi.fn()
const mockUpsertTemplate = vi.fn()
const mockLinkToJE = vi.fn()

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))
vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: (...args: unknown[]) => mockMapping(...args),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: (...args: unknown[]) => mockUpsertTemplate(...args),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: (...args: unknown[]) => mockLinkToJE(...args),
}))

import { bulkBookMatchedInboxItems } from '../categorize-core'
import { BulkBookInboxSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events/bus'

/** Queue-based supabase mock: each `from()` consumes the next queued result. */
function queuedSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const from = vi.fn(() => {
    const raw = queue.shift() ?? { data: null, error: null }
    const result = { data: raw.data ?? null, error: raw.error ?? null }
    const chain: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => chain
        },
      },
    )
    return chain
  })
  return { from } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockDetectDup.mockResolvedValue(null)
  mockMapping.mockReturnValue({
    rule: null,
    debit_account: '5420',
    credit_account: '1930',
    risk_level: 'LOW',
    confidence: 1,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Programvara',
  })
  mockCreateJE.mockResolvedValue({ id: 'je-1' })
})

describe('BulkBookInboxSchema', () => {
  it('accepts a valid payload', () => {
    const r = BulkBookInboxSchema.safeParse({
      item_ids: ['11111111-1111-4111-8111-111111111111'],
      category: 'expense_software',
      vat_treatment: 'reverse_charge',
    })
    expect(r.success).toBe(true)
  })

  // Regression: the bulk_book_inbox_items pending operation persists absent
  // optionals as explicit JSON null (stagePendingOperation in server.ts). A bare
  // `.optional()` rejected those on approval ("expected number, received null").
  it('accepts persisted params with explicit nulls and normalizes them to undefined', () => {
    const r = BulkBookInboxSchema.safeParse({
      item_ids: ['11111111-1111-4111-8111-111111111111'],
      category: 'expense_software',
      vat_treatment: null,
      vat_amount: null,
      notes: null,
      allow_duplicate: false,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      // null must not leak downstream to categorizeMatchedTransaction.
      expect(r.data.vat_treatment).toBeUndefined()
      expect(r.data.vat_amount).toBeUndefined()
      expect(r.data.notes).toBeUndefined()
    }
  })

  it('rejects an empty item_ids array', () => {
    const r = BulkBookInboxSchema.safeParse({ item_ids: [], category: 'expense_software' })
    expect(r.success).toBe(false)
  })

  it('rejects a missing category', () => {
    const r = BulkBookInboxSchema.safeParse({ item_ids: ['11111111-1111-1111-1111-111111111111'] })
    expect(r.success).toBe(false)
  })

  it('rejects an invalid category', () => {
    const r = BulkBookInboxSchema.safeParse({
      item_ids: ['11111111-1111-1111-1111-111111111111'],
      category: 'expense_unicorns',
    })
    expect(r.success).toBe(false)
  })

  it('rejects an invalid vat_treatment', () => {
    const r = BulkBookInboxSchema.safeParse({
      item_ids: ['11111111-1111-1111-1111-111111111111'],
      category: 'expense_software',
      vat_treatment: 'omvänd',
    })
    expect(r.success).toBe(false)
  })

  it('rejects more than 200 items', () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`)
    const r = BulkBookInboxSchema.safeParse({ item_ids: ids, category: 'expense_software' })
    expect(r.success).toBe(false)
  })
})

describe('bulkBookMatchedInboxItems: skip classification (never errors)', () => {
  const base = { category: 'expense_software' as const }

  it('skips an item that is not found', async () => {
    const supabase = queuedSupabase([{ data: null }])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      ...base,
      item_ids: ['missing'],
    })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'missing', reason: 'not_found' }])
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('skips an item already booked (created_journal_entry_id)', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: 'je-x', created_supplier_invoice_id: null } },
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', { ...base, item_ids: ['i1'] })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'already_booked' }])
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('skips an item linked to a supplier invoice', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: 'si-x' } },
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', { ...base, item_ids: ['i1'] })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'is_supplier_invoice' }])
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('skips an item without a matched transaction', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: null, created_journal_entry_id: null, created_supplier_invoice_id: null } },
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', { ...base, item_ids: ['i1'] })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'not_matched' }])
    expect(mockCreateJE).not.toHaveBeenCalled()
  })
})

describe('bulkBookMatchedInboxItems: booking', () => {
  it('books a matched, unbooked item against its transaction', async () => {
    const supabase = queuedSupabase([
      // 1. inbox item fetch → bookable
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      // 2. transactions fetch (categorize core)
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700.28, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      // 3. company_settings
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      // 4. ensureFiscalPeriod → existing period
      { data: [{ id: 'fp-1' }] },
      // 5. transactions update (mark booked)
      { error: null },
      // 6. propagation select (no matched inbox rows to stamp in this mock)
      { data: [] },
    ])

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
      vat_treatment: 'reverse_charge',
    })

    expect(skipped).toEqual([])
    expect(booked).toEqual([{ item_id: 'i1', transaction_id: 'tx-1', journal_entry_id: 'je-1' }])
    expect(mockCreateJE).toHaveBeenCalledTimes(1)
    // The shared core received the chosen category + reverse-charge treatment.
    expect(mockMapping).toHaveBeenCalledWith(
      'expense_software',
      expect.objectContaining({ id: 'tx-1' }),
      true,
      'aktiebolag',
      'reverse_charge',
      undefined,
    )
  })

  it('books the matched item and skips the unmatched one in a mixed batch', async () => {
    const supabase = queuedSupabase([
      // item i1 → not matched (1 from())
      { data: { id: 'i1', matched_transaction_id: null, created_journal_entry_id: null, created_supplier_invoice_id: null } },
      // item i2 → bookable, then its categorize chain
      { data: { id: 'i2', matched_transaction_id: 'tx-2', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      { data: { id: 'tx-2', date: '2026-06-02', amount: -25, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [{ id: 'fp-1' }] },
      { error: null },
      { data: [] },
    ])

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1', 'i2'],
      category: 'expense_software',
    })

    expect(skipped).toEqual([{ item_id: 'i1', reason: 'not_matched' }])
    expect(booked).toEqual([{ item_id: 'i2', transaction_id: 'tx-2', journal_entry_id: 'je-1' }])
    expect(mockCreateJE).toHaveBeenCalledTimes(1)
  })
})

describe('bulkBookMatchedInboxItems: intra-batch duplicate handling', () => {
  /** Six queued from() results for one successfully-booked item. */
  const bookableItem = (itemId: string, txId: string, amount: number) => [
    { data: { id: itemId, matched_transaction_id: txId, created_journal_entry_id: null, created_supplier_invoice_id: null } },
    { data: { id: txId, date: '2026-06-01', amount, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
    { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
    { data: [{ id: 'fp-1' }] },
    { error: null },
    { data: [] },
  ]

  it('books BOTH distinct transactions that share (date, amount) in one bulk run', async () => {
    // Model the reviewer-reported bug: the guard WOULD flag the second tx as a
    // duplicate of the first tx's freshly-created verifikat, but only when the
    // first tx is NOT excluded as a same-batch sibling. The fix must pass tx-1
    // in as an exclusion so tx-2 books instead of being skipped 409.
    mockDetectDup.mockImplementation(
      (_sb: unknown, _co: unknown, target: { id: string }, exclude?: { excludeTransactionIds?: string[] }) => {
        if (target.id === 'tx-2' && !(exclude?.excludeTransactionIds ?? []).includes('tx-1')) {
          return Promise.resolve({
            transaction_id: 'tx-1', journal_entry_id: 'je-1', voucher_label: 'A1',
            entry_date: '2026-06-01', description: null, amount: 700.28,
          })
        }
        return Promise.resolve(null)
      },
    )

    const supabase = queuedSupabase([
      ...bookableItem('i1', 'tx-1', -700.28),
      ...bookableItem('i2', 'tx-2', -700.28),
    ])

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1', 'i2'],
      category: 'expense_software',
    })

    expect(skipped).toEqual([])
    expect(booked).toEqual([
      { item_id: 'i1', transaction_id: 'tx-1', journal_entry_id: 'je-1' },
      { item_id: 'i2', transaction_id: 'tx-2', journal_entry_id: 'je-1' },
    ])
    expect(mockCreateJE).toHaveBeenCalledTimes(2)

    // The SECOND booking was handed tx-1 (and its verifikat) as an intra-batch
    // exclusion; the first was handed an empty set.
    const firstCall = mockDetectDup.mock.calls.find((c) => (c[2] as { id: string }).id === 'tx-1')
    const secondCall = mockDetectDup.mock.calls.find((c) => (c[2] as { id: string }).id === 'tx-2')
    expect(firstCall?.[3]).toEqual({ excludeTransactionIds: [], excludeJournalEntryIds: [] })
    expect(secondCall?.[3]).toEqual({ excludeTransactionIds: ['tx-1'], excludeJournalEntryIds: ['je-1'] })
  })

  it('STILL skips a pre-existing already-booked duplicate (cross-batch detection preserved)', async () => {
    // The guard fires on a duplicate that existed BEFORE this batch: its ids are
    // absent from the (empty) exclusion set, so the booking is refused (409) and
    // the item is skipped as a possible duplicate rather than double-booked.
    mockDetectDup.mockResolvedValue({
      transaction_id: 'tx-preexisting', journal_entry_id: 'je-old', voucher_label: 'A9',
      entry_date: '2026-06-01', description: null, amount: 700.28,
    })

    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700.28, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
    ])

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
    })

    expect(booked).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].item_id).toBe('i1')
    expect(skipped[0].reason).toBe('already_booked_or_duplicate')
    expect(mockCreateJE).not.toHaveBeenCalled()
  })
})
