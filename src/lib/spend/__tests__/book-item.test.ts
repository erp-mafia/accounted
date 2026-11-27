import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from './fake-db'
import { eventBus } from '@/lib/events'
import type { SpendExpenseModel } from '../types'

const h = vi.hoisted(() => {
  const state = {
    db: null as unknown as FakeDb,
    /** The service-role client: the same tables, with the tables it touched recorded. */
    adminClient: null as unknown as { from: (table: string) => unknown },
    adminTables: [] as string[],
    admin: vi.fn(),
    createDraftEntry: vi.fn(),
    commitEntry: vi.fn(),
    findFiscalPeriod: vi.fn(),
    checkPeriodLock: vi.fn(),
    linkToJournalEntry: vi.fn(),
  }
  state.admin.mockImplementation(() => state.adminClient)
  return state
})

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: h.admin }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: h.createDraftEntry,
  commitEntry: h.commitEntry,
  findFiscalPeriod: h.findFiscalPeriod,
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: h.checkPeriodLock }))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  linkToJournalEntry: h.linkToJournalEntry,
}))
// The momskoder only shape reverse-charge basis lines, which these expenses do not carry.
vi.mock('@/lib/bookkeeping/chart-vat-treatments', () => ({ fetchChartVatTreatments: vi.fn(async () => ({})) }))

import { bookSpendItem, bookSpendItems, spendItemBusinessEvent } from '../book-item'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { linkBasisColumns } from '@/lib/links/stamp'

const COMPANY = 'company-1'
const SHA = 'a'.repeat(64)
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

function ctx(companyId = COMPANY) {
  return { supabase: h.db.client as never, companyId, userId: 'user-1', log }
}

function expenseModel(overrides: Partial<SpendExpenseModel> = {}): SpendExpenseModel {
  return {
    externalId: 'exp-1',
    batchRef: null,
    kind: 'card_purchase',
    subKind: null,
    date: '2026-10-05',
    currency: 'SEK',
    amount: 125,
    original: null,
    walletAccount: null,
    lines: [{ account: '5410', amount: 125, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 25 }, dimensions: {}, description: null }],
    merchant: { name: 'Kontorsbolaget AB', country: 'SE', taxId: null, categoryCode: null },
    person: { name: 'Kim Exempel', ref: null },
    note: null,
    attendees: [],
    reference: 'P-1001',
    settles: [],
    files: [
      {
        fileRef: 'file-1',
        name: 'kvitto.pdf',
        contentType: 'application/pdf',
        size: 2048,
        sha256: 'b'.repeat(64),
        downloadUrl: 'https://files.connect.example.se/file-1',
        downloadExpiresAt: '2026-10-06T00:00:00Z',
      },
    ],
    providerUrl: null,
    issues: [],
    ...overrides,
  }
}

function itemRow(overrides: Record<string, unknown> = {}, model: SpendExpenseModel = expenseModel()): Record<string, unknown> {
  return {
    id: 'item-1',
    company_id: COMPANY,
    connection_id: 'conn-1',
    provider: 'pleo',
    external_id: model.externalId,
    batch_ref: null,
    kind: model.kind,
    expense_date: model.date,
    currency: model.currency,
    amount: model.amount,
    merchant_name: model.merchant?.name ?? null,
    person_name: model.person?.name ?? null,
    status: 'ready',
    reasons: [],
    raw_sha256: SHA,
    document_ids: model.files.length > 0 ? ['doc-1'] : [],
    received_at: '2026-10-05T12:00:00Z',
    receive_count: 1,
    ack_outcome: 'received',
    acknowledged_at: '2026-10-05T12:00:01Z',
    changed_after_booking: false,
    latest_raw_sha256: null,
    latest_received_at: null,
    journal_entry_id: null,
    booked_at: null,
    booked_by: null,
    created_at: '2026-10-05T12:00:00Z',
    updated_at: '2026-10-05T12:00:00Z',
    expense: model,
    ...overrides,
  }
}

function seed(itemOverrides: Record<string, unknown> = {}, model: SpendExpenseModel = expenseModel(), more: Record<string, unknown>[] = []) {
  h.db = createFakeDb({
    company_settings: [{ company_id: COMPANY, org_number: '556677-8899', vat_registered: true, dimensions_enabled: false }],
    spend_connections: [
      { id: 'conn-1', company_id: COMPANY, provider: 'pleo', provider_name: 'Pleo', status: 'active', settings: { wallet_account: '1940' } },
    ],
    spend_items: [itemRow(itemOverrides, model), ...more],
    chart_of_accounts: [],
    journal_entries: [],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  seed()
  h.adminTables = []
  h.adminClient = {
    from: (table: string) => {
      h.adminTables.push(table)
      return h.db.client.from(table)
    },
  }
  h.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-2026' })
  h.findFiscalPeriod.mockResolvedValue('fp-2026')
  let drafts = 0
  h.createDraftEntry.mockImplementation(async () => {
    drafts += 1
    const id = `je-${drafts}`
    h.db.tables.journal_entries.push({ id, status: 'draft' })
    return { id }
  })
  h.commitEntry.mockImplementation(async (_supabase: unknown, _companyId: string, _userId: string, entryId: string) => {
    const entry = h.db.tables.journal_entries.find((row) => row.id === entryId)!
    Object.assign(entry, { status: 'posted', voucher_series: 'A', voucher_number: 6 + Number(entryId.slice(3)) })
    return { ...entry }
  })
  h.linkToJournalEntry.mockResolvedValue(undefined)
})

describe('bookSpendItem', () => {
  it('books the expense as its own verifikat through the engine, claims it before the commit, and links the receipt', async () => {
    h.commitEntry.mockImplementationOnce(async (_supabase: unknown, _companyId: string, _userId: string, entryId: string) => {
      // The claim holds the expense before the voucher number is taken.
      expect(h.db.tables.spend_items[0].journal_entry_id).toBe(entryId)
      const entry = h.db.tables.journal_entries.find((row) => row.id === entryId)!
      Object.assign(entry, { status: 'posted', voucher_series: 'A', voucher_number: 7 })
      return { ...entry }
    })
    const outcome = await bookSpendItem(ctx(), { item_id: 'item-1', expected_raw_sha256: SHA })
    expect(outcome).toEqual({
      ok: true,
      created: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'A', voucher_number: 7, entry_date: '2026-10-05', amount: 125, linked_documents: 1 },
    })
    const [client, companyId, userId, input] = h.createDraftEntry.mock.calls[0]
    expect(client).toBe(h.db.client)
    expect([companyId, userId]).toEqual([COMPANY, 'user-1'])
    expect(input).toEqual({
      fiscal_period_id: 'fp-2026',
      entry_date: '2026-10-05',
      description: 'Kortköp Kontorsbolaget AB (Kim Exempel), Pleo',
      source_type: 'spend_item',
      source_id: 'item-1',
      notes: 'Pleo P-1001',
      lines: [
        { account_number: '5410', debit_amount: 100, credit_amount: 0, line_description: 'Kontorsbolaget AB' },
        { account_number: '2641', debit_amount: 25, credit_amount: 0, line_description: 'Ingående moms 25 %' },
        { account_number: '1940', debit_amount: 0, credit_amount: 125, line_description: 'Betalt med företagskort' },
      ],
    })
    expect(h.db.tables.spend_items[0]).toMatchObject({ journal_entry_id: 'je-1', status: 'booked', booked_by: 'user-1' })
    expect(h.db.tables.spend_items[0].booked_at).toEqual(expect.any(String))
    expect(h.linkToJournalEntry).toHaveBeenCalledWith(h.adminClient, COMPANY, 'doc-1', 'je-1', linkBasisColumns('import_carried_over'))
    // The claim and the booked mark are the server's writes; the reads went through the member's client.
    expect(new Set(h.adminTables)).toEqual(new Set(['spend_items']))
  })

  it('previews the verifikat on a dry run without the service role, and writes nothing', async () => {
    const outcome = await bookSpendItem(ctx(), { item_id: 'item-1' }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        item_id: 'item-1',
        expense_date: '2026-10-05',
        provider_name: 'Pleo',
        raw_sha256: SHA,
        acknowledged_reasons: [],
        receipts: 1,
        journal_entry: { entry_date: '2026-10-05', total_debit: 125, total_credit: 125, balanced: true },
      },
    })
    expect(h.admin).not.toHaveBeenCalled()
    expect(h.createDraftEntry).not.toHaveBeenCalled()
    expect(h.db.updates).toEqual([])
  })

  it('refuses an unknown, booked, rejected or not yet received expense, and one that changed since review', async () => {
    expect(await bookSpendItem(ctx(), { item_id: 'nope' })).toEqual({ ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: 'nope' } })
    expect(await bookSpendItem(ctx('company-2'), { item_id: 'item-1' })).toMatchObject({ ok: false, code: 'SPEND_ITEM_NOT_FOUND' })
    seed({ journal_entry_id: 'je-0', status: 'booked' })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({
      ok: false,
      code: 'SPEND_ITEM_ALREADY_BOOKED',
      details: { journal_entry_id: 'je-0' },
    })
    seed({ status: 'rejected' })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toMatchObject({ ok: false, code: 'SPEND_ITEM_NOT_BOOKABLE' })
    seed({ status: 'no_entry' }, expenseModel({ kind: 'wallet_topup', lines: [], merchant: null }))
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toMatchObject({ ok: false, code: 'SPEND_ITEM_NOT_BOOKABLE' })
    for (const ackOutcome of [null, 'rejected']) {
      seed({ ack_outcome: ackOutcome })
      expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({ ok: false, code: 'SPEND_ITEM_NOT_RECEIVED', details: { item_id: 'item-1' } })
    }
    seed()
    expect(await bookSpendItem(ctx(), { item_id: 'item-1', expected_raw_sha256: 'c'.repeat(64) })).toEqual({
      ok: false,
      code: 'SPEND_ITEM_CHANGED',
      details: { raw_sha256: SHA },
    })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('books an expense waiting for review only once a person says they looked', async () => {
    seed(
      { status: 'review', amount: 500 },
      expenseModel({
        amount: 500,
        lines: [{ account: '6071', amount: 500, vat: { code: 'SE12', type: 'standard', rate: 0.12, amount: 53.57 }, dimensions: {}, description: 'Lunch med kund' }],
        attendees: [
          { name: 'Kim Exempel', company: null, internal: true },
          { name: 'Alex Kund', company: 'Kund AB', internal: false },
        ],
      }),
    )
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({
      ok: false,
      code: 'SPEND_ITEM_NEEDS_REVIEW',
      details: { reasons: [{ code: 'representation', params: { attendees: 2 } }] },
    })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
    expect(await bookSpendItem(ctx(), { item_id: 'item-1', acknowledge_review: true })).toMatchObject({ ok: true, data: { amount: 500 } })
    expect(h.createDraftEntry.mock.calls[0][3].notes).toBe('Pleo P-1001. Deltagare: Kim Exempel, Alex Kund (Kund AB)')
  })

  it.each([
    ['personal_spend', 'Privat köp', '1685'],
    ['atm_withdrawal', 'Kontantuttag', '1910'],
  ] as const)('books a %s only on the account the person chose', async (kind, label, account) => {
    seed({ status: 'review', kind }, expenseModel({ kind, lines: [], merchant: null, files: [] }))
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toMatchObject({
      ok: false,
      code: 'SPEND_ITEM_NEEDS_REVIEW',
      details: { reasons: [{ code: 'counter_account_needed' }] },
    })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1', acknowledge_review: true })).toMatchObject({
      ok: false,
      code: 'SPEND_DEBIT_ACCOUNT_REQUIRED',
    })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1', acknowledge_review: true, debit_account: '9999' })).toEqual({
      ok: false,
      code: 'SPEND_DEBIT_ACCOUNT_UNKNOWN',
      details: { account: '9999' },
    })
    expect(h.createDraftEntry).not.toHaveBeenCalled()

    expect(await bookSpendItem(ctx(), { item_id: 'item-1', acknowledge_review: true, debit_account: account })).toMatchObject({ ok: true })
    expect(h.createDraftEntry.mock.calls[0][3]).toMatchObject({
      description: `${label} (Kim Exempel), Pleo`,
      notes: 'Pleo P-1001. Inget kvitto från utgiftsplattformen.',
      lines: [
        { account_number: account, debit_amount: 125, credit_amount: 0, line_description: label },
        { account_number: '1940', debit_amount: 0, credit_amount: 125, line_description: label },
      ],
    })
  })

  it('refuses a locked period before drafting anything, also when it locked after the expense was checked', async () => {
    h.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-2026' })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({ ok: false, code: 'PERIOD_LOCKED', details: { entry_date: '2026-10-05' } })

    h.checkPeriodLock
      .mockResolvedValueOnce({ locked: false, fiscal_period_id: 'fp-2026' })
      .mockResolvedValueOnce({ locked: true, reason: 'company_lock_date_covers' })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({
      ok: false,
      code: 'PERIOD_LOCKED',
      details: { reason: 'company_lock_date_covers', entry_date: '2026-10-05' },
    })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('needs a fiscal year for the date', async () => {
    h.checkPeriodLock.mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toMatchObject({
      ok: false,
      code: 'SPEND_ITEM_NEEDS_REVIEW',
      details: { reasons: [{ code: 'no_fiscal_period', params: { date: '2026-10-05' } }] },
    })
    h.findFiscalPeriod.mockResolvedValue(null)
    expect(await bookSpendItem(ctx(), { item_id: 'item-1', acknowledge_review: true })).toEqual({
      ok: false,
      code: 'SPEND_ITEM_NO_FISCAL_PERIOD',
      details: { entry_date: '2026-10-05' },
    })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('answers already booked when the live-voucher index refuses the draft', async () => {
    h.createDraftEntry.mockRejectedValue(new BookkeepingDatabaseError('create_draft_entry', 'duplicate key', '23505'))
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({ ok: false, code: 'SPEND_ITEM_ALREADY_BOOKED', details: { item_id: 'item-1' } })
    expect(h.commitEntry).not.toHaveBeenCalled()
  })

  it('cancels its draft when another booking claimed the expense first', async () => {
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      // The other request claims between our draft and our claim.
      h.db.tables.spend_items[0].journal_entry_id = 'je-other'
      return { id: 'je-1' }
    })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({
      ok: false,
      code: 'SPEND_ITEM_ALREADY_BOOKED',
      details: { journal_entry_id: 'je-other' },
    })
    expect(h.db.tables.journal_entries[0].status).toBe('cancelled')
    expect(h.commitEntry).not.toHaveBeenCalled()
  })

  it('cancels its draft when a newer export replaced the expense between the read and the claim', async () => {
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      h.db.tables.spend_items[0].raw_sha256 = 'c'.repeat(64)
      return { id: 'je-1' }
    })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({
      ok: false,
      code: 'SPEND_ITEM_CHANGED',
      details: { raw_sha256: 'c'.repeat(64) },
    })
    expect(h.db.tables.journal_entries[0].status).toBe('cancelled')
    expect(h.db.tables.spend_items[0].journal_entry_id).toBeNull()
  })

  it('unlinks the expense and cancels the draft when the commit fails', async () => {
    h.commitEntry.mockRejectedValue(new Error('commit_journal_entry failed'))
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toEqual({ ok: false, code: 'SPEND_ITEM_BOOKING_FAILED' })
    expect(h.db.tables.spend_items[0]).toMatchObject({ journal_entry_id: null, status: 'ready' })
    expect(h.db.tables.journal_entries[0].status).toBe('cancelled')
    expect(h.linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('finishes the booking when the commit posted but its answer was lost', async () => {
    h.commitEntry.mockImplementation(async () => {
      Object.assign(h.db.tables.journal_entries[0], { status: 'posted', voucher_series: 'A', voucher_number: 9 })
      throw new Error('fetch failed')
    })
    expect(await bookSpendItem(ctx(), { item_id: 'item-1' })).toMatchObject({
      ok: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'A', voucher_number: 9 },
    })
    expect(h.db.tables.spend_items[0]).toMatchObject({ journal_entry_id: 'je-1', status: 'booked' })
    expect(h.db.tables.journal_entries[0].status).toBe('posted')
  })

  it('keeps the booking when a receipt cannot be linked, and says so', async () => {
    h.linkToJournalEntry.mockRejectedValue(new Error('storage down'))
    const outcome = await bookSpendItem(ctx(), { item_id: 'item-1' })
    expect(outcome).toMatchObject({
      ok: true,
      data: { journal_entry_id: 'je-1', linked_documents: 0 },
      warnings: [{ code: 'SPEND_ITEM_RECEIPT_NOT_LINKED' }],
    })
    expect(h.db.tables.spend_items[0]).toMatchObject({ status: 'booked' })
  })
})

describe('bookSpendItems', () => {
  function seedMany() {
    seed({}, expenseModel(), [
      itemRow(
        { id: 'item-2', external_id: 'exp-2', kind: 'fee', amount: 80 },
        expenseModel({
          externalId: 'exp-2',
          kind: 'fee',
          amount: 80,
          merchant: null,
          lines: [{ account: '6570', amount: 80, vat: { code: 'MOMSFRI', type: 'standard', rate: 0, amount: null }, dimensions: {}, description: 'Kortavgift' }],
        }),
      ),
      itemRow({ id: 'item-review', external_id: 'exp-3', status: 'review' }, expenseModel({ externalId: 'exp-3' })),
      itemRow({ id: 'item-booked', external_id: 'exp-4', status: 'booked', journal_entry_id: 'je-0' }, expenseModel({ externalId: 'exp-4' })),
    ])
  }

  it('books each ready expense as its own verifikat and reports the rest by code', async () => {
    seedMany()
    const outcome = await bookSpendItems(ctx(), { item_ids: ['item-1', 'item-2', 'item-review', 'item-booked', 'nope'] })
    expect(outcome).toMatchObject({
      ok: true,
      created: true,
      data: {
        booked: [
          { item_id: 'item-1', journal_entry_id: 'je-1', voucher_number: 7, amount: 125 },
          { item_id: 'item-2', journal_entry_id: 'je-2', voucher_number: 8, amount: 80 },
        ],
        failed: [
          { item_id: 'item-review', code: 'SPEND_ITEM_NOT_READY' },
          { item_id: 'item-booked', code: 'SPEND_ITEM_NOT_READY' },
          { item_id: 'nope', code: 'SPEND_ITEM_NOT_READY' },
        ],
      },
    })
    expect(h.createDraftEntry.mock.calls.map((call) => call[3].source_id)).toEqual(['item-1', 'item-2'])
    expect(h.createDraftEntry.mock.calls[1][3].lines).toEqual([
      { account_number: '6570', debit_amount: 80, credit_amount: 0, line_description: 'Kortavgift' },
      { account_number: '1940', debit_amount: 0, credit_amount: 80, line_description: 'Betalt med företagskort' },
    ])
  })

  it('keeps the others booked when one booking fails', async () => {
    seedMany()
    h.createDraftEntry.mockImplementationOnce(async () => {
      throw new Error('connection reset')
    })
    expect(await bookSpendItems(ctx(), { item_ids: ['item-1', 'item-2'] })).toMatchObject({
      ok: true,
      created: true,
      data: {
        booked: [{ item_id: 'item-2', journal_entry_id: 'je-1' }],
        failed: [{ item_id: 'item-1', code: 'SPEND_ITEM_BOOKING_FAILED' }],
      },
    })
    expect(h.db.tables.spend_items.find((row) => row.id === 'item-1')).toMatchObject({ status: 'ready', journal_entry_id: null })
  })

  it('takes at most fifty distinct expenses per batch', async () => {
    seedMany()
    const outcome = await bookSpendItems(ctx(), { item_ids: [...Array.from({ length: 55 }, (_, i) => `missing-${i}`), 'item-1'] })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.created).toBe(false)
    expect(outcome.data.booked).toEqual([])
    expect(outcome.data.failed).toHaveLength(50)
    expect(h.createDraftEntry).not.toHaveBeenCalled()

    // A repeated id books once.
    expect(await bookSpendItems(ctx(), { item_ids: ['item-1', 'item-1'] })).toMatchObject({
      ok: true,
      data: { booked: [{ item_id: 'item-1' }], failed: [] },
    })
    expect(h.createDraftEntry).toHaveBeenCalledTimes(1)
  })

  it('prices a dry run at what the verifikat post, without the service role, and writes nothing', async () => {
    seedMany()
    expect(await bookSpendItems(ctx(), { item_ids: ['item-1', 'item-2', 'item-review'] }, { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        item_ids: ['item-1', 'item-2'],
        skipped: ['item-review'],
        total_debit: 205,
        entries: [
          { item_id: 'item-1', total_debit: 125 },
          { item_id: 'item-2', total_debit: 80 },
        ],
      },
    })
    expect(h.admin).not.toHaveBeenCalled()
    expect(h.createDraftEntry).not.toHaveBeenCalled()
    expect(h.db.updates).toEqual([])
  })
})

describe('spendItemBusinessEvent', () => {
  it('records the purchase in kronor with its deducted VAT, the first receipt and the money going out', () => {
    const row = itemRow({ document_ids: ['doc-1', 'doc-2'] }) as never
    expect(spendItemBusinessEvent(row, 25, linkBasisColumns('user_created'))).toMatchObject({
      kind: 'purchase.spend_expense',
      category: null,
      occurredOn: '2026-10-05',
      currency: 'SEK',
      amount: 125,
      amountSek: 125,
      taxAmounts: [{ tax: 'vat', treatment: null, amount_sek: 25 }],
      evidence: { direction: 'out', document_id: 'doc-1', link_basis: 'user_created' },
      mappingVersion: expect.stringMatching(/^se\.spend-expense@/),
      jurisdiction: 'SE',
    })
  })

  it('records a refund as money coming in, with no VAT line when none was deducted', () => {
    const row = itemRow({ amount: -125, kind: 'refund', document_ids: [] }) as never
    const event = spendItemBusinessEvent(row, 0, linkBasisColumns('user_created'))
    expect(event).toMatchObject({ amount: 125, amountSek: 125, taxAmounts: [], evidence: { direction: 'in' } })
    expect(event.evidence).not.toHaveProperty('document_id')
  })
})
