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

// The pair guard (lib/operations/inbox-pair-guard.ts, tested there): here only that the door asks and obeys.
const refuseWhenPairBookedMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations/inbox-pair-guard', () => ({
  refuseWhenPairBooked: (...args: unknown[]) => refuseWhenPairBookedMock(...args),
}))


const mockCreateJE = vi.fn()
const mockDetectDup = vi.fn()
const mockMapping = vi.fn()
const mockUpsertTemplate = vi.fn()
const mockLinkToJE = vi.fn()

// suggestion_log is recorded around every booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
// suggestion_log records each inbox decision; its reads and writes are
// covered in lib/suggestion-log, not by this file's queued client.
vi.mock('@/lib/suggestion-log/inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/inbox')>()),
  snapshotInboxExtraction: vi.fn(async (_supabase: unknown, companyId: string, item: { id: string; document_id?: string | null }) => ({
    companyId,
    inboxItemId: item.id,
    documentId: item.document_id ?? null,
    extraction: null,
    model: null,
  })),
  loadEntryLines: vi.fn(async () => []),
  recordInboxDecision: vi.fn(async () => undefined),
}))

vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

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

// The service's own checks that have their own tests: the chart
// pre-validation, the period-lock pre-check and the merchant-rule learning.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/mapping-engine')>()),
  saveUserMappingRule: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { bulkBookMatchedInboxItems, type BulkBookInboxFiledVatQuestion } from '../categorize-core'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { recordInboxDecision } from '@/lib/suggestion-log/inbox'
import { TransactionMissingSekValueError } from '@/lib/bookkeeping/errors'
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
      dimensions: null,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      // null must not leak downstream to categorizeMatchedTransaction.
      expect(r.data.vat_treatment).toBeUndefined()
      expect(r.data.vat_amount).toBeUndefined()
      expect(r.data.notes).toBeUndefined()
      expect(r.data.dimensions).toBeUndefined()
    }
  })

  it('accepts a shared dimensions bag and rejects a malformed one', () => {
    const ok = BulkBookInboxSchema.safeParse({
      item_ids: ['11111111-1111-4111-8111-111111111111'],
      category: 'expense_software',
      dimensions: { '6': 'P001' },
    })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.dimensions).toEqual({ '6': 'P001' })

    const bad = BulkBookInboxSchema.safeParse({
      item_ids: ['11111111-1111-4111-8111-111111111111'],
      category: 'expense_software',
      // Key must be a SIE dim number: 'projekt' is not.
      dimensions: { projekt: 'P001' },
    })
    expect(bad.success).toBe(false)
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

  it("skips an item whose staged extraction is still in flight (status 'processing')", async () => {
    // Staged upload: the row exists with extracted_data NULL while the
    // deferred worker runs. Matched or not, it must not book from empty data.
    const supabase = queuedSupabase([
      { data: { id: 'i1', status: 'processing', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', { ...base, item_ids: ['i1'] })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'extraction_in_progress' }])
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

  it('skips an item whose other half of the purchase is booked already, naming that verifikat', async () => {
    refuseWhenPairBookedMock.mockResolvedValueOnce({
      ok: false,
      code: 'INBOX_ITEM_PAIR_ALREADY_BOOKED',
      details: {},
      messageSv: 'Kvittot från samma köp är redan bokfört på verifikat A66. Lägg till det här underlaget där i stället, så bokförs köpet inte två gånger.',
      messageEn: 'x',
    })
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', { ...base, item_ids: ['i1'] })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'pair_already_booked', detail: expect.stringContaining('A66') }])
    expect(refuseWhenPairBookedMock).toHaveBeenCalledWith(supabase, 'c1', 'i1')
    expect(mockCreateJE).not.toHaveBeenCalled()
  })
})

describe('bulkBookMatchedInboxItems: booking', () => {
  it('books a matched, unbooked item against its transaction', async () => {
    const supabase = queuedSupabase([
      // 1. inbox item fetch → bookable; its reading names an EU seller
      {
        data: {
          id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null,
          extracted_data: { supplier: { vatNumber: 'DE123456789' } },
        },
      },
      // 2. transactions fetch (categorize core)
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700.28, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      // 3. company_settings
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [] }, // the seller-VAT check: no other inbox item matched to the row
      // 4. ensureFiscalPeriod → existing period
      { data: [{ id: 'fp-1' }] },
      // 5. transactions update (mark booked)
      { data: [{ id: 'tx-1' }], error: null },
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
      // company_settings.vat_registered as loaded: this settings row has none.
      null,
      // The box the item's own seller gives: an EU service, ruta 21.
      'eu_services',
    )
  })

  it('books against the linked cash account instead of the 1930 mapping default', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      {
        data: {
          id: 'tx-1',
          date: '2026-06-01',
          amount: -700.28,
          currency: 'SEK',
          cash_account_id: 'cash-1',
          journal_entry_id: null,
        },
      },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: { ledger_account: '1931', currency: 'SEK' } }, // resolveSettlementAccount: explicit cash_account_id lookup
      { data: [{ id: 'fp-1' }] },
      { data: [{ id: 'tx-1' }], error: null },
      { data: [] },
    ])

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
    })

    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1', cash_account_id: 'cash-1' }),
      expect.objectContaining({ debit_account: '5420', credit_account: '1931' }),
      undefined,
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
  })

  it('forwards the shared dimensions bag onto every booked mapping result', async () => {
    // Fresh mapping object per call: the core mutates it in place, and a
    // shared fixture would leak dimensions across tests.
    mockMapping.mockImplementation(() => ({
      rule: null,
      debit_account: '5420',
      credit_account: '1930',
      risk_level: 'LOW',
      confidence: 1,
      requires_review: false,
      default_private: false,
      vat_lines: [],
      description: 'Programvara',
    }))
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [{ id: 'fp-1' }] },
      { data: [{ id: 'tx-1' }], error: null },
      { data: [] },
    ])

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
      dimensions: { '6': 'P001' },
    })

    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.objectContaining({ dimensions: { '6': 'P001' } }),
      undefined,
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
  })

  it('books the matched item and skips the unmatched one in a mixed batch', async () => {
    const supabase = queuedSupabase([
      // item i1 → not matched (1 from())
      { data: { id: 'i1', matched_transaction_id: null, created_journal_entry_id: null, created_supplier_invoice_id: null } },
      // item i2 → bookable, then its categorize chain
      { data: { id: 'i2', matched_transaction_id: 'tx-2', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      { data: { id: 'tx-2', date: '2026-06-02', amount: -25, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [{ id: 'fp-1' }] },
      { data: [{ id: 'tx-2' }], error: null },
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

// #58 "Bulk doors carry no box": under reverse charge each item books the box
// its own seller and the shared category give (swedish-vat skill 2.1-2.3:
// ruta 21 EU services, 22 services from outside the EU, 20 EU goods), and an
// item whose box cannot be told is left out with the reason, never booked in
// ruta 21 by default.
describe('bulkBookMatchedInboxItems: the reverse-charge box per item', () => {
  /** The categorize chain of one booked item after its inbox row (see the booking tests above). */
  function bookedChain(txId: string, reverseCharge = true) {
    return [
      { data: { id: txId, date: '2026-10-01', amount: -500, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      // A reverse charge's seller-VAT check reads the inbox items matched to the row.
      ...(reverseCharge ? [{ data: [] }] : []),
      { data: [{ id: 'fp-1' }] },
      { data: [{ id: txId }], error: null },
      { data: { document_id: null } }, // propagation: tx pin lookup
      { data: [] }, // propagation: matched inbox items
    ]
  }
  function item(id: string, txId: string, supplier: Record<string, string | null> | null, extra: Record<string, unknown> = {}) {
    return {
      data: {
        id, matched_transaction_id: txId, created_journal_entry_id: null, created_supplier_invoice_id: null,
        extracted_data: supplier ? { supplier } : null,
        ...extra,
      },
    }
  }
  /** The reverse-charge kind each buildMappingResultFromCategory call received (its 8th argument). */
  const kindsBooked = () => mockMapping.mock.calls.map((call) => call[7])

  it('books a service from a US seller in ruta 22 (non_eu_services)', async () => {
    const supabase = queuedSupabase([
      item('i1', 'tx-1', { vatNumber: null, address: '1 Example Ave, Austin, TX 78701' }),
      ...bookedChain('tx-1'),
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'], category: 'expense_software', vat_treatment: 'reverse_charge',
    })
    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
    expect(kindsBooked()).toEqual(['non_eu_services'])
  })

  it('books goods from an EU seller in ruta 20 (eu_goods)', async () => {
    const supabase = queuedSupabase([item('i1', 'tx-1', { vatNumber: 'DE123456789' }), ...bookedChain('tx-1')])
    const { booked } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'], category: 'expense_equipment', vat_treatment: 'reverse_charge',
    })
    expect(booked).toHaveLength(1)
    expect(kindsBooked()).toEqual(['eu_goods'])
  })

  it('skips an item whose seller country cannot be read, with the reason, and books nothing', async () => {
    const supabase = queuedSupabase([item('i1', 'tx-1', { vatNumber: null, address: null })])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'], category: 'expense_software', vat_treatment: 'reverse_charge',
    })
    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'reverse_charge_box_unknown', detail: expect.stringMatching(/land går inte att läsa/) }])
    expect(mockCreateJE).not.toHaveBeenCalled()
    expect(mockMapping).not.toHaveBeenCalled()
  })

  it("reads a matched supplier card's foreign type when the reading names no country", async () => {
    const supabase = queuedSupabase([
      item('i1', 'tx-1', { vatNumber: null }, { matched_supplier_id: 'sup-1' }),
      { data: { supplier_type: 'non_eu_business' } },
      ...bookedChain('tx-1'),
    ])
    const { booked } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'], category: 'expense_software', vat_treatment: 'reverse_charge',
    })
    expect(booked).toHaveLength(1)
    expect(kindsBooked()).toEqual(['non_eu_services'])
  })

  it('books each item of a mixed run in its own box and leaves out the one it cannot place', async () => {
    const supabase = queuedSupabase([
      item('i-eu', 'tx-1', { vatNumber: 'IE1234567T' }),
      ...bookedChain('tx-1'),
      item('i-us', 'tx-2', { vatNumber: null, iban: null, address: '1 Example Ave, Austin, TX 78701' }),
      ...bookedChain('tx-2'),
      item('i-unknown', 'tx-3', null),
      item('i-se', 'tx-4', { orgNumber: '556677-8899' }),
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i-eu', 'i-us', 'i-unknown', 'i-se'], category: 'expense_software', vat_treatment: 'reverse_charge',
    })
    expect(booked.map((b) => b.item_id)).toEqual(['i-eu', 'i-us'])
    expect(kindsBooked()).toEqual(['eu_services', 'non_eu_services'])
    expect(skipped.map((s) => [s.item_id, s.reason])).toEqual([
      ['i-unknown', 'reverse_charge_box_unknown'],
      ['i-se', 'reverse_charge_box_unknown'],
    ])
    expect(skipped[1].detail).toMatch(/Säljaren är svensk/)
  })

  // #94: omvänd skattskyldighet only covers a purchase the seller charged no
  // VAT on. The single door and the Inkorg's one click refuse a reading that
  // shows a charge; the bulk door booked it with fiktiv moms on top.
  it('skips an item whose reading shows the seller charged VAT, naming the charge', async () => {
    const charged = (id: string, extracted: Record<string, unknown>) => ({
      data: { id, matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null, extracted_data: extracted },
    })
    const supabase = queuedSupabase([
      charged('i-total', { supplier: { vatNumber: 'IE1234567T' }, totals: { vatAmount: 23 }, invoice: { currency: 'EUR' } }),
      charged('i-breakdown', { supplier: { vatNumber: 'IE1234567T' }, totals: { vatAmount: 0 }, vatBreakdown: [{ rate: 0.23, amount: 11.5 }] }),
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i-total', 'i-breakdown'], category: 'expense_software', vat_treatment: 'reverse_charge',
    })
    expect(booked).toEqual([])
    expect(skipped.map((s) => [s.item_id, s.reason])).toEqual([
      ['i-total', 'reverse_charge_seller_vat'],
      ['i-breakdown', 'reverse_charge_seller_vat'],
    ])
    expect(skipped[0].detail).toMatch(/debiterat moms \(23 EUR\)/)
    expect(skipped[1].detail).toMatch(/\(11,5\)/)
    expect(mockMapping).not.toHaveBeenCalled()
  })

  it('books the same reading under its own VAT: only reverse charge is refused', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null, extracted_data: { totals: { vatAmount: 100 } } } },
      ...bookedChain('tx-1', false),
    ])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'], category: 'expense_software', vat_treatment: 'standard_25',
    })
    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
  })

  it('reads no box for a treatment other than reverse charge', async () => {
    const supabase = queuedSupabase([item('i1', 'tx-1', null), ...bookedChain('tx-1', false)])
    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'], category: 'expense_software', vat_treatment: 'standard_25',
    })
    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
    expect(kindsBooked()).toEqual([undefined])
  })
})

// Agent feedback seq 887729: a foreign row with no SEK value is refused by the
// engine. The skip names that cause instead of "no account mapping", which
// would send the user to the wrong fix.
describe('bulkBookMatchedInboxItems: a foreign row without a SEK value', () => {
  it('skips it as missing_sek_value with the Swedish reason, and books nothing', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null } },
      { data: { id: 'tx-1', date: '2026-06-01', amount: -200, currency: 'CAD', amount_sek: null, exchange_rate: null, cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no CAD cash account -> 1930
      { data: [{ id: 'fp-1' }] }, // ensureFiscalPeriod: an open period covers the date
    ])
    mockCreateJE.mockRejectedValue(new TransactionMissingSekValueError('tx-1', 'CAD', '2026-06-01'))

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
    })

    expect(booked).toEqual([])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ item_id: 'i1', reason: 'missing_sek_value' })
    expect(skipped[0].detail).toMatch(/saknar SEK-belopp och växelkurs/)
  })
})

describe('bulkBookMatchedInboxItems: WhatsApp channel-context notes threading', () => {
  const WA_CONTEXT = {
    channel: 'whatsapp',
    representation: {
      participants: [
        { name: 'Anna Berg', company: 'Volvo' },
        { name: 'Jakob W', company: null },
      ],
      purpose: 'uppföljning av avtal',
      event_date: null,
      raw_answer: 'raw',
      answered_at: '2026-08-01T12:00:00Z',
    },
  }
  const RENDERED = 'Representation: Anna Berg (Volvo), Jakob W · Syfte: uppföljning av avtal'

  const bookableWaItem = () => [
    { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null, channel_context: WA_CONTEXT } },
    { data: { id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
    { data: [] }, // the gate: no posted verifikat booked from the row (#203)
    { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
    { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
    { data: [{ id: 'fp-1' }] },
    { data: [{ id: 'tx-1' }], error: null },
    { data: [] },
  ]

  it('threads the rendered channel context into the verifikat notes', async () => {
    const supabase = queuedSupabase(bookableWaItem())

    const { booked, skipped } = await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
    })

    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
    // createTransactionJournalEntry(supabase, companyId, userId, tx, mapping, notes)
    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.anything(),
      RENDERED,
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
  })

  it('keeps the shared batch note AND the per-item channel context', async () => {
    const supabase = queuedSupabase(bookableWaItem())

    await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
      notes: 'Gemensam batchanteckning',
    })

    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.anything(),
      `Gemensam batchanteckning · ${RENDERED}`,
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
  })

  // Regression (adversarial review): the photo caption is chat text nobody
  // was asked for and nobody reviewed, and this loop books every selected item
  // with no per-item notes field. Burning it into a posted verifikat
  // description would need a formal rättelse to undo, so only the answered
  // parts (representation, user_note) are threaded here.
  it('does NOT thread an unreviewed photo caption into the verifikat notes', async () => {
    const supabase = queuedSupabase([
      {
        data: {
          id: 'i1',
          matched_transaction_id: 'tx-1',
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
          channel_context: {
            channel: 'whatsapp',
            caption: 'kvittot från igår, Annas sjukbesök, hon betalade',
          },
        },
      },
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [{ id: 'fp-1' }] },
      { error: null },
      { data: [] },
    ])

    await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
      notes: 'Gemensam batchanteckning',
    })

    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.anything(),
      'Gemensam batchanteckning',
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
    const passedNotes = mockCreateJE.mock.calls[0][5] as string | undefined
    expect(passedNotes).not.toContain('sjukbesök')
  })

  it('threads the answered parts of a captioned item and drops the caption', async () => {
    const supabase = queuedSupabase([
      {
        data: {
          id: 'i1',
          matched_transaction_id: 'tx-1',
          created_journal_entry_id: null,
          created_supplier_invoice_id: null,
          channel_context: { ...WA_CONTEXT, caption: 'random bildtext' },
        },
      },
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [{ id: 'fp-1' }] },
      { error: null },
      { data: [] },
    ])

    await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
    })

    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.anything(),
      RENDERED,
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
  })

  it('passes notes through unchanged for items without channel context', async () => {
    const supabase = queuedSupabase([
      { data: { id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null, channel_context: null } },
      { data: { id: 'tx-1', date: '2026-06-01', amount: -700, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
      { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
      { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
      { data: [{ id: 'fp-1' }] },
      { error: null },
      { data: [] },
    ])

    await bulkBookMatchedInboxItems(supabase, 'u1', 'c1', {
      item_ids: ['i1'],
      category: 'expense_software',
      notes: 'Bara batchanteckningen',
    })

    expect(mockCreateJE).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'u1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.anything(),
      'Bara batchanteckningen',
      // The posting port pilot adds the business event context beside it.
      expect.objectContaining({ rubricVersion: undefined }),
    )
  })
})

describe('bulkBookMatchedInboxItems: intra-batch duplicate handling', () => {
  /** Seven queued from() results for one successfully-booked item. */
  const bookableItem = (itemId: string, txId: string, amount: number) => [
    { data: { id: itemId, matched_transaction_id: txId, created_journal_entry_id: null, created_supplier_invoice_id: null } },
    { data: { id: txId, date: '2026-06-01', amount, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
    { data: [] }, // the gate: no posted verifikat booked from the row (#203)
    { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
    { data: [] }, // resolveSettlementAccount: no enabled cash accounts -> 1930
    { data: [{ id: 'fp-1' }] },
    { data: [{ id: txId }], error: null },
    { data: { document_id: null } }, // propagation: tx pin lookup
    { data: [] }, // propagation: matched inbox items
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

    // Each booked underlag gets its own decision row, beside its bank line's.
    expect(vi.mocked(recordInboxDecision)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(recordInboxDecision).mock.calls.map((c) => (c[1] as { inboxItemId: string }).inboxItemId)).toEqual(['i1', 'i2'])
    expect(vi.mocked(recordInboxDecision).mock.calls[0][2]).toMatchObject({ journal_entry_id: 'je-1' })
    // Its guards are the bank line's booking's, the item's own unbooked state first.
    expect(vi.mocked(recordInboxDecision).mock.calls[0][4]).toEqual([
      { id: 'already_booked', result: 'pass', detail: null },
      { id: 'duplicate', result: 'pass', detail: null },
      { id: 'counter_legs', result: 'pass', detail: null },
      { id: 'chart', result: 'pass', detail: null },
      { id: 'period_lock', result: 'pass', detail: null },
    ])
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
      { data: [] }, // the gate: no posted verifikat booked from the row (#203)
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

// Inkorgen's "Bokför valda" (the dashboard door) asks before an underlag is
// booked into a momsperiod whose declaration is filed; the approval executor
// hands no question in and books as staged.
describe('bulkBookMatchedInboxItems: the filed-momsperiod question', () => {
  const WARNING: VoucherWarning = {
    code: 'VAT_PERIOD_ALREADY_FILED',
    message_sv: 'Bokningen ändrar underlaget för en momsdeklaration som redan är inlämnad: 2026-Q3 (inlämnad 2026-11-11). Görs bokningen kan deklarationen behöva rättas.',
    message_en: 'en',
    details: {},
  }
  const ITEM = {
    data: {
      id: 'i1', matched_transaction_id: 'tx-1', created_journal_entry_id: null, created_supplier_invoice_id: null,
      extracted_data: null,
    },
  }
  // An inbox item and the categorize chain of its booking (bookedChain above).
  const BOOKING_QUEUE = [
    ITEM,
    { data: { id: 'tx-1', date: '2026-09-27', amount: -500, currency: 'SEK', cash_account_id: null, journal_entry_id: null } },
    { data: [] },
    { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } },
    { data: [] },
    { data: [{ id: 'fp-1' }] },
    { data: [{ id: 'tx-1' }], error: null },
    { data: { document_id: null } }, // propagation: tx pin lookup
    { data: [] }, // propagation: matched inbox items
  ]
  const INPUT = { item_ids: ['i1'], category: 'expense_software' as const, vat_treatment: 'standard_25' as const, notes: 'Batch' }
  const question = (confirmed: boolean, answer: VoucherWarning | null) => ({
    confirmed,
    ask: vi.fn<BulkBookInboxFiledVatQuestion['ask']>(async () => answer),
    record: vi.fn<BulkBookInboxFiledVatQuestion['record']>(async () => undefined),
  })

  it('holds back an underlag whose booking changes a filed declaration, with the warning, and books nothing', async () => {
    const filedVat = question(false, WARNING)

    const { booked, skipped } = await bulkBookMatchedInboxItems(queuedSupabase([ITEM]), 'u1', 'c1', INPUT, { filedVat })

    expect(booked).toEqual([])
    expect(skipped).toEqual([{ item_id: 'i1', reason: 'filed_vat_period', detail: WARNING.message_sv, warning: WARNING }])
    expect(mockCreateJE).not.toHaveBeenCalled()
    expect(filedVat.record).not.toHaveBeenCalled()
    // Asked about the booking this item would get, with the options it is booked with.
    expect(filedVat.ask).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ is_business: true, category: 'expense_software', vat_treatment: 'standard_25', notes: 'Batch' }),
      expect.objectContaining({
        onBooked: 'refuse',
        invoiceMatchIntercept: false,
        withoutReview: true,
        exclude: { excludeTransactionIds: [], excludeJournalEntryIds: [] },
      }),
    )
  })

  it('books it once the person has confirmed, and records the booking as made past the warning', async () => {
    const filedVat = question(true, WARNING)

    const { booked, skipped } = await bulkBookMatchedInboxItems(queuedSupabase(BOOKING_QUEUE), 'u1', 'c1', INPUT, { filedVat })

    expect(skipped).toEqual([])
    expect(booked).toEqual([{ item_id: 'i1', transaction_id: 'tx-1', journal_entry_id: 'je-1' }])
    expect(filedVat.ask).toHaveBeenCalledTimes(1)
    expect(filedVat.record).toHaveBeenCalledWith('je-1', WARNING)
  })

  it('books an underlag the question says nothing about, and records nothing', async () => {
    const filedVat = question(false, null)

    const { booked, skipped } = await bulkBookMatchedInboxItems(queuedSupabase(BOOKING_QUEUE), 'u1', 'c1', INPUT, { filedVat })

    expect(skipped).toEqual([])
    expect(booked).toHaveLength(1)
    expect(filedVat.record).not.toHaveBeenCalled()
  })

  it('asks about a later underlag with the batch\'s earlier bookings left out of its duplicate guard', async () => {
    const filedVat = {
      confirmed: false,
      ask: vi.fn<BulkBookInboxFiledVatQuestion['ask']>(async (transactionId) => (transactionId === 'tx-2' ? WARNING : null)),
      record: vi.fn<BulkBookInboxFiledVatQuestion['record']>(async () => undefined),
    }
    const later = { data: { ...ITEM.data, id: 'i2', matched_transaction_id: 'tx-2' } }

    const { booked, skipped } = await bulkBookMatchedInboxItems(
      queuedSupabase([...BOOKING_QUEUE, later]),
      'u1',
      'c1',
      { ...INPUT, item_ids: ['i1', 'i2'] },
      { filedVat },
    )

    expect(booked.map((b) => b.item_id)).toEqual(['i1'])
    expect(skipped.map((s) => [s.item_id, s.reason])).toEqual([['i2', 'filed_vat_period']])
    // The dry run of the second booking must not take the first, just booked,
    // for a duplicate: it would be refused, and the underlag booked unasked.
    expect(filedVat.ask.mock.calls[1][2].exclude).toEqual({
      excludeTransactionIds: ['tx-1'],
      excludeJournalEntryIds: ['je-1'],
    })
  })

  it('asks about a reverse charge in the box the underlag\'s own seller gives', async () => {
    const filedVat = question(false, WARNING)
    const euItem = { data: { ...ITEM.data, extracted_data: { supplier: { vatNumber: 'DE123456789' } } } }

    await bulkBookMatchedInboxItems(
      queuedSupabase([euItem]),
      'u1',
      'c1',
      { item_ids: ['i1'], category: 'expense_software', vat_treatment: 'reverse_charge' },
      { filedVat },
    )

    expect(filedVat.ask).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ vat_treatment: 'reverse_charge', reverse_charge_kind: 'eu_services' }),
      expect.anything(),
    )
  })

  it('keeps booking the rest of the batch around a held underlag', async () => {
    const filedVat = {
      confirmed: false,
      ask: vi.fn<BulkBookInboxFiledVatQuestion['ask']>(async (transactionId) => (transactionId === 'tx-held' ? WARNING : null)),
      record: vi.fn<BulkBookInboxFiledVatQuestion['record']>(async () => undefined),
    }
    const held = { data: { ...ITEM.data, id: 'i0', matched_transaction_id: 'tx-held' } }

    const { booked, skipped } = await bulkBookMatchedInboxItems(
      queuedSupabase([held, ...BOOKING_QUEUE]),
      'u1',
      'c1',
      { ...INPUT, item_ids: ['i0', 'i1'] },
      { filedVat },
    )

    expect(skipped.map((s) => [s.item_id, s.reason])).toEqual([['i0', 'filed_vat_period']])
    expect(booked.map((b) => b.item_id)).toEqual(['i1'])
  })
})
