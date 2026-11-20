import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsSettlement, CollectionsSettlementLine } from '@accounted/connect-contract'
import { sumOre } from '@/lib/money'
import { createMemorySupabase, type MemorySupabase } from './memory-supabase'
import { CollectionsError } from '../errors'
import type { CollectionsAdapter } from '../port'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: vi.fn(),
  uploadDocument: vi.fn(),
}))

import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import {
  bookSettlement,
  findHandBookedPayout,
  importSettlements,
  normalizeSettlementRow,
  previewSettlementVoucher,
  resolvePossibleDuplicate,
  runSettlementSync,
  SETTLEMENT_VAT_INVOICE_ACCEPTED,
  storeSettlement,
  type SettlementServiceDeps,
} from '../settlements'
import { fakePdfDocument } from '../adapters/fake'
import { normalizeConnectionRow } from '../connection'
import { SAMPLE_MULTI_CLAIM_SETTLEMENT, SAMPLE_SETTLEMENTS } from './settlement-samples'

const COMPANY = 'company-1'
const CONNECTION = 'connection-1'
const USER = 'user-1'
const CASE = 'case-1'
const INVOICE = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e5f'
const MERGED_1 = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e11'
const MERGED_2 = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e12'
const FOREIGN_INVOICE = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e99'
const NOW = new Date('2026-10-06T12:00:00.000Z')

let mem: MemorySupabase
let adapter: {
  settlements: ReturnType<typeof vi.fn>
  settlement: ReturnType<typeof vi.fn>
  settlementDocument: ReturnType<typeof vi.fn>
  markSettlementBooked: ReturnType<typeof vi.fn>
}
let bookCollected: ReturnType<typeof vi.fn>
let archiveDocument: ReturnType<typeof vi.fn>
let copyDocument: ReturnType<typeof vi.fn>
let linkBankRow: ReturnType<typeof vi.fn>

function settlementLine(overrides: Partial<CollectionsSettlementLine> & Pick<CollectionsSettlementLine, 'kind' | 'amount'>): CollectionsSettlementLine {
  return {
    inPayout: overrides.kind !== 'informational',
    taxAmount: 0,
    recipient: 'creditor',
    caseRef: null,
    invoiceRef: null,
    originalInvoiceRefs: [],
    providerType: 'Capital/Creditor/CreditorMainClaim',
    description: null,
    ...overrides,
  }
}

function providerSettlement(overrides: Partial<CollectionsSettlement> = {}): CollectionsSettlement {
  return {
    settlementRef: '7731',
    paymentDate: '2026-10-01',
    amount: 843.75,
    currency: 'SEK',
    statusOk: true,
    settlementDate: '2026-10-01',
    statusCode: 'OK/Valid',
    bankReference: 'PAYOUT 7731',
    lines: [
      settlementLine({ kind: 'principal', amount: 1000, caseRef: 'claim-1', invoiceRef: INVOICE, description: 'Kapital, Tolvan Tolvansson' }),
      settlementLine({ kind: 'agency_commission', amount: 125, taxAmount: 31.25, recipient: 'agency', providerType: 'Capital/Agency/CollectionProvision' }),
      settlementLine({ kind: 'agency_fee_vat', amount: 31.25, recipient: 'agency', providerType: 'Capital/Agency/Tax' }),
      settlementLine({ kind: 'informational', amount: 60, recipient: 'agency', providerType: 'CaseFee/Agency/None' }),
    ],
    raw: { settlementId: 7731 },
    ...overrides,
  }
}

function seedWorld(options: { autoBookSettlements?: boolean; vatRegistered?: boolean } = {}) {
  mem.seed('collection_connections', [
    {
      id: CONNECTION,
      company_id: COMPANY,
      route: 'connect',
      state: 'active',
      user_id: USER,
      consented_by: USER,
      display_name: 'Acme Inkasso',
      connection_handle: 'handle-1',
      clearing_account: '1689',
      payout_account: '1930',
      auto_book_collected_payments: false,
      auto_book_settlements: options.autoBookSettlements ?? false,
      ended_at: null,
    },
  ])
  mem.seed('collection_cases', [
    { id: CASE, company_id: COMPANY, invoice_id: INVOICE, connection_id: CONNECTION, provider_case_ref: 'claim-1', submission_status: 'registered', created_at: '2026-09-01T00:00:00Z' },
  ])
  mem.seed('invoices', [
    { id: INVOICE, company_id: COMPANY },
    { id: MERGED_1, company_id: COMPANY },
    { id: MERGED_2, company_id: COMPANY },
  ])
  mem.seed('company_settings', [{ company_id: COMPANY, vat_registered: options.vatRegistered ?? true }])
  mem.seed('collection_collected_payments', [
    {
      id: 'collected-1',
      company_id: COMPANY,
      case_id: CASE,
      invoice_id: INVOICE,
      provider_payment_ref: 'pay-1',
      paid_at: '2026-09-27',
      capital_paid: 1000,
      status: 'booked',
      invoice_payment_id: 'ip-1',
      journal_entry_id: 'je-c1',
      settlement_id: null,
    },
  ])
}

/** Bank rows nothing books: the table holds them and open_bank_rows answers them. */
function seedOpenRows(rows: Record<string, unknown>[]) {
  mem.seed('transactions', rows)
  mem.seed('open_bank_rows', rows)
}

function connection() {
  return normalizeConnectionRow(mem.rows('collection_connections')[0]!)
}

function deps(overrides: Partial<SettlementServiceDeps> = {}): SettlementServiceDeps {
  return {
    db: mem.client as SupabaseClient,
    now: () => NOW,
    adapterFor: () => adapter as unknown as CollectionsAdapter,
    bookCollected: bookCollected as unknown as SettlementServiceDeps['bookCollected'],
    archiveDocument: archiveDocument as unknown as SettlementServiceDeps['archiveDocument'],
    copyDocument: copyDocument as unknown as SettlementServiceDeps['copyDocument'],
    linkBankRow: linkBankRow as unknown as SettlementServiceDeps['linkBankRow'],
    vatInvoiceAccepted: true,
    ...overrides,
  }
}

async function storedSettlement(settlement = providerSettlement()): Promise<string> {
  const id = await storeSettlement(mem.client as SupabaseClient, connection(), settlement)
  if (!id) throw new Error('not stored')
  return id
}

function settlementRow(id: string) {
  return mem.rows('collection_settlements').find((s) => s.id === id)!
}

beforeEach(() => {
  vi.clearAllMocks()
  mem = createMemorySupabase()
  adapter = {
    settlements: vi.fn().mockResolvedValue([]),
    settlement: vi.fn(),
    settlementDocument: vi.fn().mockResolvedValue(fakePdfDocument('Avrakning-7731.pdf')),
    markSettlementBooked: vi.fn().mockResolvedValue(null),
  }
  bookCollected = vi.fn().mockResolvedValue({ ok: true })
  archiveDocument = vi.fn().mockResolvedValue('doc-1')
  copyDocument = vi.fn().mockImplementation(async (input: { journalEntryId: string }) => `copy-${input.journalEntryId}`)
  // The existing link path: links the row to the voucher and clears its invoice hint.
  linkBankRow = vi.fn().mockImplementation(async (_db: unknown, _userId: string, companyId: string, params: { transactionId: string; journalEntryId: string }) => {
    const tx = mem.rows('transactions').find((t) => t.id === params.transactionId && t.company_id === companyId)!
    Object.assign(tx, { journal_entry_id: params.journalEntryId, potential_invoice_id: null })
    return { ok: true, result: { transactionId: params.transactionId, journalEntryId: params.journalEntryId } }
  })
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-d1' } as Awaited<ReturnType<typeof createJournalEntry>>)
})

describe('storeSettlement', () => {
  it('stores the payout once, each line tied to its case and invoice, without the provider free text', async () => {
    seedWorld()
    const id = await storedSettlement()
    expect(await storeSettlement(mem.client as SupabaseClient, connection(), providerSettlement())).toBeNull()
    expect(mem.rows('collection_settlements')).toHaveLength(1)
    expect(settlementRow(id)).toMatchObject({
      company_id: COMPANY,
      connection_id: CONNECTION,
      provider_settlement_ref: '7731',
      payment_date: '2026-10-01',
      amount: 843.75,
      status: 'received',
      bank_reference: 'PAYOUT 7731',
    })
    const lines = mem.rows('collection_settlement_lines').sort((a, b) => Number(a.position) - Number(b.position))
    expect(lines.map((l) => [l.position, l.kind, l.case_id, l.invoice_id, l.amount, l.tax_amount])).toEqual([
      [0, 'principal', CASE, INVOICE, 1000, 0],
      [1, 'agency_commission', null, null, 125, 31.25],
      [2, 'agency_fee_vat', null, null, 31.25, 0],
      [3, 'informational', null, null, 60, 0],
    ])
    expect(lines.every((l) => l.description === null)).toBe(true)
    expect(JSON.stringify(mem.rows('collection_settlement_lines'))).not.toContain('Tolvan')
  })

  it('keeps only the company\'s own invoices on a merged line, and stores a payout the provider marks invalid as failed', async () => {
    seedWorld()
    await storedSettlement(
      providerSettlement({
        settlementRef: '7732',
        statusOk: false,
        lines: [settlementLine({ kind: 'principal', amount: 800, caseRef: 'parent-claim', originalInvoiceRefs: [MERGED_1, MERGED_2, FOREIGN_INVOICE, 'not-a-uuid'] })],
      }),
    )
    expect(mem.rows('collection_settlements')[0]).toMatchObject({ status: 'failed' })
    expect(mem.rows('collection_settlement_lines')[0]).toMatchObject({ case_id: null, invoice_id: null, original_invoice_ids: [MERGED_1, MERGED_2] })
  })
})

describe('importSettlements', () => {
  it('reads the payouts since the first lookback, stores the new ones, and later starts from the last one less the overlap', async () => {
    seedWorld()
    adapter.settlements.mockResolvedValue([{ settlementRef: '7731', paymentDate: '2026-10-01', amount: 843.75, currency: 'SEK', statusOk: true }])
    adapter.settlement.mockResolvedValue(providerSettlement())
    expect(await importSettlements(deps(), connection())).toEqual({ listed: 1, stored: 1 })
    expect(adapter.settlements.mock.calls[0]![0]).toEqual({ companyId: COMPANY, connectionHandle: 'handle-1' })
    expect(adapter.settlements.mock.calls[0]![1]).toEqual({ since: '2026-06-08' })

    expect(await importSettlements(deps(), connection())).toEqual({ listed: 1, stored: 0 })
    expect(adapter.settlements.mock.calls[1]![1]).toEqual({ since: '2026-09-17' })
    expect(adapter.settlement).toHaveBeenCalledTimes(1)
  })

  it('removes a payout whose lines could not be stored, so the next import stores it whole', async () => {
    seedWorld()
    adapter.settlements.mockResolvedValue([{ settlementRef: '7731', paymentDate: '2026-10-01', amount: 843.75, currency: 'SEK', statusOk: true }])
    adapter.settlement.mockResolvedValue(providerSettlement())
    mem.failures.set('collection_settlement_lines:insert', { message: 'connection reset' })
    await expect(importSettlements(deps(), connection())).rejects.toThrow(/collection_settlement_lines insert failed/)
    expect(mem.rows('collection_settlements')).toEqual([])

    mem.failures.clear()
    expect(await importSettlements(deps(), connection())).toEqual({ listed: 1, stored: 1 })
    expect(mem.rows('collection_settlement_lines')).toHaveLength(4)
  })

  it('stores nothing when the provider answers another payout than the one asked for', async () => {
    seedWorld()
    adapter.settlements.mockResolvedValue([{ settlementRef: '7731', paymentDate: '2026-10-01', amount: 843.75, currency: 'SEK', statusOk: true }])
    adapter.settlement.mockResolvedValue(providerSettlement({ settlementRef: '9999' }))
    expect(await importSettlements(deps(), connection())).toEqual({ listed: 1, stored: 0 })
    expect(mem.rows('collection_settlements')).toEqual([])
  })
})

describe('bookSettlement', () => {
  it('books the payout voucher with the PDF as underlag, ties the collected payment to it and tells the provider', async () => {
    seedWorld()
    const id = await storedSettlement()
    const result = await bookSettlement(deps(), COMPANY, id, { userId: USER })
    expect(result).toEqual({ ok: true, journalEntryId: 'je-d1', alreadyBooked: false, acknowledged: true })

    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    const [, companyId, userId, input] = vi.mocked(createJournalEntry).mock.calls[0]!
    expect(companyId).toBe(COMPANY)
    expect(userId).toBe(USER)
    expect(input).toMatchObject({ fiscal_period_id: 'fp-1', entry_date: '2026-10-01', source_type: 'collection_settlement', source_id: id })
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['2641', 31.25, 0],
    ])
    expect(input.description).toBe('Utbetalning från Acme Inkasso PAYOUT 7731')

    expect(archiveDocument).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: USER }))
    expect(linkToJournalEntry).toHaveBeenCalledWith(mem.client, COMPANY, 'doc-1', 'je-d1', expect.objectContaining({ link_basis: 'system_derived' }))
    expect(settlementRow(id)).toMatchObject({
      status: 'booked',
      journal_entry_id: 'je-d1',
      document_attachment_id: 'doc-1',
      booked_by: USER,
      booking_lease_until: null,
      provider_acknowledged_at: NOW.toISOString(),
    })
    const lines = mem.rows('collection_settlement_lines').sort((a, b) => Number(a.position) - Number(b.position))
    expect(lines.map((l) => [l.account_number, l.vat_account_number, l.booked === true])).toEqual([
      ['1689', null, true],
      ['6062', null, true],
      ['2641', null, true],
      [null, null, false],
    ])
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ settlement_id: id })
    // The settlement PDF is underlag of the C voucher it settles too, as a copy.
    expect(copyDocument).toHaveBeenCalledTimes(1)
    expect(copyDocument).toHaveBeenCalledWith({
      companyId: COMPANY,
      userId: USER,
      documentId: 'doc-1',
      journalEntryId: 'je-c1',
      scope: `collection-settlement:${id}`,
    })
    expect(adapter.markSettlementBooked).toHaveBeenCalledWith(
      { companyId: COMPANY, connectionHandle: 'handle-1' },
      { idempotencyKey: `${id}:je-d1`, settlementRef: '7731', internalRef: 'je-d1' },
    )
  })

  it('stays unbooked when a copy of the PDF fails, and finishes the copies on the next attempt without a second voucher', async () => {
    seedWorld()
    const id = await storedSettlement()
    copyDocument.mockRejectedValueOnce(new Error('storage down'))
    vi.mocked(createJournalEntry).mockImplementationOnce(async (_db, companyId, _userId, input) => {
      mem.seed('journal_entries', [{ id: 'je-d1', company_id: companyId, source_type: input.source_type, source_id: input.source_id, status: 'posted' }])
      return { id: 'je-d1' } as Awaited<ReturnType<typeof createJournalEntry>>
    })
    await expect(bookSettlement(deps(), COMPANY, id, { userId: USER })).rejects.toThrow('storage down')
    expect(settlementRow(id)).toMatchObject({ status: 'received', booking_lease_until: null })

    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-d1', alreadyBooked: true })
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    expect(copyDocument).toHaveBeenCalledTimes(2)
    expect(copyDocument).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc-1', journalEntryId: 'je-c1' }))
  })

  it('never clears the capital of a collected payment whose voucher a rebook reversed but did not finish', async () => {
    seedWorld()
    // The rebook died between its storno and its release: the payment still reads booked.
    mem.seed('journal_entries', [{ id: 'je-c1', company_id: COMPANY, status: 'reversed', reversed_by_id: 'je-storno' }])
    const id = await storedSettlement()
    const result = await bookSettlement(deps(), COMPANY, id, { userId: USER })
    expect(result).toMatchObject({ ok: false, outcome: 'needs_mapping', reason: 'collected_payment_unbooked' })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'booked', settlement_id: null })

    // Once the rebook is finished (the payment booked again on a posted voucher) the payout books.
    Object.assign(mem.rows('collection_collected_payments')[0]!, { journal_entry_id: 'je-c2' })
    mem.seed('journal_entries', [{ id: 'je-c2', company_id: COMPANY, status: 'posted' }])
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-d1' })
  })

  it('books the cases\' pending collected payments first', async () => {
    seedWorld()
    mem.seed('collection_collected_payments', [
      { id: 'collected-2', company_id: COMPANY, case_id: CASE, invoice_id: INVOICE, provider_payment_ref: 'pay-2', paid_at: '2026-09-28', capital_paid: 50, status: 'pending', settlement_id: null },
    ])
    const id = await storedSettlement()
    await bookSettlement(deps(), COMPANY, id, null)
    expect(bookCollected).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }), 'collected-2', null)
  })

  it('leaves the VAT to a person while the settlement is not accepted as a VAT invoice, then books the choice', async () => {
    expect(SETTLEMENT_VAT_INVOICE_ACCEPTED).toBe(false)
    seedWorld()
    const id = await storedSettlement()
    const blocked = await bookSettlement(deps({ vatInvoiceAccepted: undefined }), COMPANY, id, { userId: USER })
    expect(blocked).toMatchObject({ ok: false, outcome: 'needs_mapping', reason: 'vat_unconfirmed' })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(settlementRow(id)).toMatchObject({ status: 'needs_mapping', needs_mapping_reason: 'vat_unconfirmed', booking_lease_until: null })

    const vatLine = mem.rows('collection_settlement_lines').find((l) => l.kind === 'agency_fee_vat')!
    Object.assign(vatLine, { account_number: '6062', account_chosen_by: USER })
    const booked = await bookSettlement(deps({ vatInvoiceAccepted: undefined }), COMPANY, id, { userId: USER })
    expect(booked).toMatchObject({ ok: true })
    const input = vi.mocked(createJournalEntry).mock.calls[0]![3]
    expect(input.lines.map((l) => l.account_number)).toEqual(['1930', '1689', '6062', '6062'])
  })

  it('refuses a payout that seems booked by hand already', async () => {
    seedWorld()
    mem.seed('transactions', [
      { id: 'tx-1', company_id: COMPANY, date: '2026-10-03', amount: 843.75, description: 'Insättning PAYOUT 7731', original_description: null, journal_entry_id: 'je-manual' },
    ])
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ outcome: 'needs_mapping', reason: 'possible_duplicate' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('sees a payout booked by hand through a voucher link (bulk-booked or split, no pointer on the row)', async () => {
    seedWorld()
    mem.seed('transactions', [
      {
        id: 'tx-1',
        company_id: COMPANY,
        date: '2026-10-03',
        amount: 843.75,
        description: 'Insättning PAYOUT 7731',
        original_description: null,
        journal_entry_id: null,
        transaction_voucher_links: [{ journal_entry_id: 'je-bulk', role: 'bank_line' }],
      },
    ])
    const id = await storedSettlement()
    expect(await findHandBookedPayout(mem.client as SupabaseClient, normalizeSettlementRow(settlementRow(id)))).toBe('je-bulk')
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ outcome: 'needs_mapping', reason: 'possible_duplicate' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('is not fooled by an unbooked bank row or another amount', async () => {
    seedWorld()
    mem.seed('transactions', [
      { id: 'tx-1', company_id: COMPANY, date: '2026-10-03', amount: 843.75, description: 'PAYOUT 7731', original_description: null, journal_entry_id: null },
      { id: 'tx-2', company_id: COMPANY, date: '2026-10-03', amount: 843.7, description: 'PAYOUT 7731', original_description: null, journal_entry_id: 'je-x' },
    ])
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ ok: true })
  })

  it('needs a person when no open fiscal period covers the payout day', async () => {
    seedWorld()
    vi.mocked(findFiscalPeriod).mockResolvedValue(null)
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ outcome: 'needs_mapping', reason: 'no_fiscal_period' })
  })

  it('waits for a settlement document the provider has not written yet, without changing the status', async () => {
    seedWorld()
    adapter.settlementDocument.mockRejectedValue(new CollectionsError('no document yet', { code: 'CONNECTOR_UPSTREAM_ERROR', retryable: true }))
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toEqual({ ok: false, outcome: 'document_unavailable' })
    expect(settlementRow(id)).toMatchObject({ status: 'received', booking_lease_until: null })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('maps an account missing from the chart to needs_mapping', async () => {
    seedWorld()
    vi.mocked(createJournalEntry).mockRejectedValue(new AccountsNotInChartError(['6062']))
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ outcome: 'needs_mapping', reason: 'account_not_in_chart' })
  })

  it('finishes a payout whose voucher exists (a run that died after booking) without a second voucher', async () => {
    seedWorld()
    const id = await storedSettlement()
    mem.seed('journal_entries', [{ id: 'je-earlier', company_id: COMPANY, source_type: 'collection_settlement', source_id: id, status: 'posted' }])
    // The earlier run archived the PDF and died before linking it to its voucher.
    settlementRow(id).document_attachment_id = 'doc-earlier'
    mem.seed('document_attachments', [{ id: 'doc-earlier', company_id: COMPANY, journal_entry_id: null }])
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ ok: true, journalEntryId: 'je-earlier', alreadyBooked: true })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(archiveDocument).not.toHaveBeenCalled()
    expect(linkToJournalEntry).toHaveBeenCalledWith(mem.client, COMPANY, 'doc-earlier', 'je-earlier', expect.objectContaining({ link_basis: 'system_derived' }))
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ settlement_id: id })
    expect(copyDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc-earlier', journalEntryId: 'je-c1' }))
  })

  it('leaves a PDF that already sits on the voucher as it is', async () => {
    seedWorld()
    const id = await storedSettlement()
    mem.seed('journal_entries', [{ id: 'je-earlier', company_id: COMPANY, source_type: 'collection_settlement', source_id: id, status: 'posted' }])
    settlementRow(id).document_attachment_id = 'doc-earlier'
    mem.seed('document_attachments', [{ id: 'doc-earlier', company_id: COMPANY, journal_entry_id: 'je-earlier' }])
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ ok: true, journalEntryId: 'je-earlier', alreadyBooked: true })
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('answers a booked payout, a payout in flight and a failed payout without booking', async () => {
    seedWorld()
    const id = await storedSettlement()
    await bookSettlement(deps(), COMPANY, id, null)
    expect(await bookSettlement(deps(), COMPANY, id, null)).toEqual({ ok: true, journalEntryId: 'je-d1', alreadyBooked: true, acknowledged: true })

    const busy = await storedSettlement(providerSettlement({ settlementRef: '7733' }))
    settlementRow(busy).booking_lease_until = new Date(NOW.getTime() + 60_000).toISOString()
    expect(await bookSettlement(deps(), COMPANY, busy, null)).toEqual({ ok: false, outcome: 'busy' })

    const failed = await storedSettlement(providerSettlement({ settlementRef: '7734', statusOk: false }))
    expect(await bookSettlement(deps(), COMPANY, failed, null)).toEqual({ ok: false, outcome: 'not_bookable' })
    expect(await bookSettlement(deps(), 'company-2', id, null)).toEqual({ ok: false, outcome: 'not_found' })
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('keeps the booking when the provider does not take the booked mark yet; the sync run tells it later', async () => {
    seedWorld()
    adapter.markSettlementBooked.mockRejectedValueOnce(new CollectionsError('down', { code: 'CONNECTOR_UPSTREAM_ERROR', retryable: true }))
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ ok: true, acknowledged: false })
    expect(settlementRow(id)).toMatchObject({ status: 'booked' })
    expect(settlementRow(id).provider_acknowledged_at ?? null).toBeNull()

    expect(await runSettlementSync(deps(), { importAll: false })).toMatchObject({ acknowledged: 1, imported: 0 })
    expect(settlementRow(id)).toMatchObject({ provider_acknowledged_at: NOW.toISOString() })
    expect(adapter.settlements).not.toHaveBeenCalled()
  })
})

describe('previewSettlementVoucher', () => {
  it('answers the voucher the booking posts, and writes, claims and books nothing', async () => {
    seedWorld()
    const id = await storedSettlement()
    const writesBefore = mem.writes.length
    const preview = await previewSettlementVoucher(deps(), COMPANY, id)
    expect(preview?.ok).toBe(true)
    expect(mem.writes.length).toBe(writesBefore)
    expect(settlementRow(id).status).toBe('received')
    expect(settlementRow(id).booking_lease_until ?? null).toBeNull()
    expect(bookCollected).not.toHaveBeenCalled()

    await bookSettlement(deps(), COMPANY, id, { userId: USER })
    const posted = vi.mocked(createJournalEntry).mock.calls[0]![3].lines
    expect(preview!.ok && preview!.lines).toEqual(posted)
    expect(await previewSettlementVoucher(deps(), 'company-2', id)).toBeNull()
  })

  it('counts the payout\'s pending collected payments as booked and applies account choices without recording them', async () => {
    seedWorld()
    Object.assign(mem.rows('collection_collected_payments')[0]!, { status: 'pending', journal_entry_id: null, invoice_payment_id: null })
    const id = await storedSettlement()
    const vatLine = mem.rows('collection_settlement_lines').find((l) => l.kind === 'agency_fee_vat')!
    const plain = await previewSettlementVoucher(deps({ vatInvoiceAccepted: undefined }), COMPANY, id)
    expect(plain).toMatchObject({ ok: false, reason: 'vat_unconfirmed' })

    const chosen = await previewSettlementVoucher(deps({ vatInvoiceAccepted: undefined }), COMPANY, id, [
      { position: Number(vatLine.position), accountNumber: '6062' },
    ])
    expect(chosen?.ok && chosen.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 843.75, 0],
      ['1689', 0, 1000],
      ['6062', 125, 0],
      ['6062', 31.25, 0],
    ])
    expect([vatLine.account_number ?? null, vatLine.account_chosen_by ?? null]).toEqual([null, null])
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ status: 'pending', settlement_id: null })
    expect(bookCollected).not.toHaveBeenCalled()
  })
})

describe('runSettlementSync', () => {
  it('makes no provider call on a dark installation', async () => {
    expect(await runSettlementSync(deps(), { importAll: true })).toEqual({
      imported: 0,
      booked: 0,
      needsMapping: 0,
      acknowledged: 0,
      bankLinked: 0,
      failed: 0,
      deferred: 0,
    })
    expect(adapter.settlements).not.toHaveBeenCalled()
  })

  it('imports once a night and books automatically only where the company turned it on', async () => {
    seedWorld({ autoBookSettlements: false })
    adapter.settlements.mockResolvedValue([{ settlementRef: '7731', paymentDate: '2026-10-01', amount: 843.75, currency: 'SEK', statusOk: true }])
    adapter.settlement.mockResolvedValue(providerSettlement())
    expect(await runSettlementSync(deps(), { importAll: true })).toMatchObject({ imported: 1, booked: 0 })
    expect(createJournalEntry).not.toHaveBeenCalled()

    mem.rows('collection_connections')[0]!.auto_book_settlements = true
    expect(await runSettlementSync(deps(), { importAll: true })).toMatchObject({ imported: 0, booked: 1 })
    expect(vi.mocked(createJournalEntry).mock.calls[0]![2]).toBe(USER)
  })

  it('counts a failing connection and goes on', async () => {
    seedWorld()
    adapter.settlements.mockRejectedValue(new CollectionsError('down', { code: 'CONNECTOR_UPSTREAM_ERROR', retryable: true }))
    expect(await runSettlementSync(deps(), { importAll: true })).toMatchObject({ failed: 1 })
  })
})

describe('resolvePossibleDuplicate', () => {
  async function heldAsDuplicate(): Promise<string> {
    seedWorld()
    mem.seed('transactions', [
      { id: 'tx-1', company_id: COMPANY, date: '2026-10-03', amount: 843.75, description: 'Insättning PAYOUT 7731', original_description: null, journal_entry_id: 'je-manual' },
    ])
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ outcome: 'needs_mapping', reason: 'possible_duplicate' })
    return id
  }

  it('books a payout a person confirms is not a duplicate, and does not ask again', async () => {
    const id = await heldAsDuplicate()
    const result = await resolvePossibleDuplicate(deps(), COMPANY, id, { userId: USER }, { resolution: 'not_duplicate' })
    expect(result).toMatchObject({ ok: true, resolution: 'not_duplicate', booking: { ok: true, journalEntryId: 'je-d1' } })
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    expect(settlementRow(id)).toMatchObject({ status: 'booked', duplicate_cleared_by: USER, duplicate_cleared_at: NOW.toISOString() })
  })

  it('marks a payout handled elsewhere as ignored with the reason, and never books it', async () => {
    const id = await heldAsDuplicate()
    const result = await resolvePossibleDuplicate(deps(), COMPANY, id, { userId: USER }, { resolution: 'handled_elsewhere', reason: '  Bokförd för hand på A 112  ' })
    expect(result).toEqual({ ok: true, resolution: 'handled_elsewhere' })
    expect(settlementRow(id)).toMatchObject({ status: 'ignored', ignored_reason: 'Bokförd för hand på A 112', ignored_by: USER, ignored_at: NOW.toISOString() })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toEqual({ ok: false, outcome: 'not_bookable' })
  })

  it('marks a payout with a claim the books do not know as handled elsewhere, but never books it as "not a duplicate"', async () => {
    seedWorld()
    const id = await storedSettlement()
    Object.assign(settlementRow(id), { status: 'needs_mapping', needs_mapping_reason: 'unknown_case' })
    expect(await resolvePossibleDuplicate(deps(), COMPANY, id, { userId: USER }, { resolution: 'not_duplicate' })).toEqual({
      ok: false,
      outcome: 'not_possible_duplicate',
    })
    expect(
      await resolvePossibleDuplicate(deps(), COMPANY, id, { userId: USER }, { resolution: 'handled_elsewhere', reason: 'Ärendet skickades direkt till inkassobolaget' }),
    ).toEqual({ ok: true, resolution: 'handled_elsewhere' })
    expect(settlementRow(id)).toMatchObject({ status: 'ignored', ignored_reason: 'Ärendet skickades direkt till inkassobolaget', ignored_by: USER })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a payout that is not held as a possible duplicate, an empty reason and a booking in flight', async () => {
    seedWorld()
    const received = await storedSettlement()
    expect(await resolvePossibleDuplicate(deps(), COMPANY, received, { userId: USER }, { resolution: 'not_duplicate' })).toEqual({
      ok: false,
      outcome: 'not_possible_duplicate',
    })
    expect(await resolvePossibleDuplicate(deps(), COMPANY, 'missing', { userId: USER }, { resolution: 'not_duplicate' })).toEqual({
      ok: false,
      outcome: 'not_found',
    })
    mem.seed('transactions', [
      { id: 'tx-1', company_id: COMPANY, date: '2026-10-03', amount: 843.75, description: 'PAYOUT 7731', original_description: null, journal_entry_id: 'je-manual' },
    ])
    await bookSettlement(deps(), COMPANY, received, null)
    expect(
      await resolvePossibleDuplicate(deps(), COMPANY, received, { userId: USER }, { resolution: 'handled_elsewhere', reason: '   ' }),
    ).toEqual({ ok: false, outcome: 'invalid_reason' })
    settlementRow(received).booking_lease_until = new Date(NOW.getTime() + 60_000).toISOString()
    expect(await resolvePossibleDuplicate(deps(), COMPANY, received, { userId: USER }, { resolution: 'not_duplicate' })).toEqual({
      ok: false,
      outcome: 'busy',
    })
    expect(settlementRow(received).status).toBe('needs_mapping')
    expect(settlementRow(received).duplicate_cleared_at ?? null).toBeNull()
  })
})

describe('the payout bank row', () => {
  const payoutRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'tx-payout',
    company_id: COMPANY,
    date: '2026-10-02',
    amount: 843.75,
    description: 'Insättning PAYOUT 7731',
    original_description: null,
    journal_entry_id: null,
    potential_invoice_id: 'invoice-open',
    ...overrides,
  })

  it('links the bank row of the payout to the payout voucher and clears its invoice hint', async () => {
    seedWorld()
    seedOpenRows([payoutRow(), payoutRow({ id: 'tx-other', amount: 900 }), payoutRow({ id: 'tx-late', date: '2026-10-08' })])
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-d1' })
    expect(linkBankRow).toHaveBeenCalledTimes(1)
    expect(linkBankRow).toHaveBeenCalledWith(mem.client, USER, COMPANY, { transactionId: 'tx-payout', journalEntryId: 'je-d1' })
    expect(settlementRow(id)).toMatchObject({ status: 'booked', bank_transaction_id: 'tx-payout' })
    expect(mem.rows('transactions').find((t) => t.id === 'tx-payout')).toMatchObject({ journal_entry_id: 'je-d1', potential_invoice_id: null })
  })

  it('links only a bank row of the account the payout voucher debits', async () => {
    seedWorld()
    mem.seed('cash_accounts', [
      { id: 'ca-1930', company_id: COMPANY, ledger_account: '1930' },
      { id: 'ca-1940', company_id: COMPANY, ledger_account: '1940' },
    ])
    // The payout voucher debits the payout account 1930.
    mem.seed('journal_entry_lines', [
      { journal_entry_id: 'je-d1', account_number: '1930', debit_amount: 843.75, credit_amount: 0 },
      { journal_entry_id: 'je-d1', account_number: '1689', debit_amount: 0, credit_amount: 1000 },
    ])
    // The same payout text and amount on another bank account: never this voucher's row.
    seedOpenRows([payoutRow({ id: 'tx-1940', cash_account_id: 'ca-1940' })])
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-d1' })
    expect(linkBankRow).not.toHaveBeenCalled()

    // The row on the payout account's bank account is linked on the next run; the other is left alone.
    seedOpenRows([payoutRow({ id: 'tx-1930', cash_account_id: 'ca-1930' })])
    expect(await runSettlementSync(deps(), { importAll: false })).toMatchObject({ bankLinked: 1 })
    expect(linkBankRow).toHaveBeenCalledWith(mem.client, USER, COMPANY, { transactionId: 'tx-1930', journalEntryId: 'je-d1' })
    expect(settlementRow(id)).toMatchObject({ bank_transaction_id: 'tx-1930' })
  })

  it('leaves two candidate rows to a person, and the booking stands when the link is refused', async () => {
    seedWorld()
    seedOpenRows([payoutRow(), payoutRow({ id: 'tx-twin' })])
    const id = await storedSettlement()
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true })
    expect(linkBankRow).not.toHaveBeenCalled()
    expect(settlementRow(id).bank_transaction_id ?? null).toBeNull()

    mem.rows('transactions').splice(1, 1)
    mem.rows('open_bank_rows').splice(1, 1)
    linkBankRow.mockResolvedValueOnce({ ok: false, code: 'LINK_TX_TX_ALREADY_LINKED' })
    expect(await runSettlementSync(deps(), { importAll: false })).toMatchObject({ bankLinked: 0 })
    expect(linkBankRow).toHaveBeenCalledTimes(1)
    expect(settlementRow(id).bank_transaction_id ?? null).toBeNull()
  })

  it('finds the bank row of a payout without a reference by the provider name, and never by the amount alone', async () => {
    seedWorld()
    seedOpenRows([
      payoutRow({ id: 'tx-customer', description: 'Insättning Tolvan Tolvansson' }),
      payoutRow({ id: 'tx-provider', date: '2026-10-03', description: 'BG ACME INKASSO AB' }),
    ])
    const id = await storedSettlement(providerSettlement({ bankReference: null }))
    expect(settlementRow(id).bank_reference).toBeNull()
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true, journalEntryId: 'je-d1' })
    expect(linkBankRow).toHaveBeenCalledTimes(1)
    expect(linkBankRow).toHaveBeenCalledWith(mem.client, USER, COMPANY, { transactionId: 'tx-provider', journalEntryId: 'je-d1' })
  })

  it('sees a payout without a reference already booked by hand from a booked bank row with the provider name', async () => {
    seedWorld()
    mem.seed('transactions', [payoutRow({ description: 'BG ACME INKASSO AB', journal_entry_id: 'je-manual', potential_invoice_id: null })])
    const id = await storedSettlement(providerSettlement({ bankReference: null }))
    expect(await findHandBookedPayout(mem.client as SupabaseClient, normalizeSettlementRow(settlementRow(id)))).toBe('je-manual')
    expect(await bookSettlement(deps(), COMPANY, id, null)).toMatchObject({ outcome: 'needs_mapping', reason: 'possible_duplicate' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('links a bank row that reached the bank feed after the booking on a later sync run', async () => {
    seedWorld()
    const id = await storedSettlement()
    await bookSettlement(deps(), COMPANY, id, { userId: USER })
    expect(linkBankRow).not.toHaveBeenCalled()
    seedOpenRows([payoutRow()])
    expect(await runSettlementSync(deps(), { importAll: false })).toMatchObject({ bankLinked: 1 })
    expect(settlementRow(id)).toMatchObject({ bank_transaction_id: 'tx-payout' })
    expect(await runSettlementSync(deps(), { importAll: false })).toMatchObject({ bankLinked: 0 })
    expect(linkBankRow).toHaveBeenCalledTimes(1)
  })
})

describe('runSettlementSync: the run budget', () => {
  it('starts nothing once the budget is spent and counts what waits for the next run', async () => {
    seedWorld({ autoBookSettlements: true })
    const id = await storedSettlement()
    await bookSettlement(deps(), COMPANY, id, { userId: USER })
    settlementRow(id).provider_acknowledged_at = null
    seedOpenRows([
      { id: 'tx-payout', company_id: COMPANY, date: '2026-10-02', amount: 843.75, description: 'PAYOUT 7731', original_description: null, journal_entry_id: null },
    ])
    adapter.markSettlementBooked.mockClear()
    const summary = await runSettlementSync(deps(), { importAll: true, budgetMs: 0, clock: () => 1_000 })
    expect(summary).toMatchObject({ acknowledged: 0, bankLinked: 0, imported: 0, deferred: 3 })
    expect(adapter.markSettlementBooked).not.toHaveBeenCalled()
    expect(adapter.settlements).not.toHaveBeenCalled()
    expect(linkBankRow).not.toHaveBeenCalled()
  })

  it('stops between steps when the budget runs out midway', async () => {
    seedWorld()
    const id = await storedSettlement()
    await bookSettlement(deps(), COMPANY, id, { userId: USER })
    settlementRow(id).provider_acknowledged_at = null
    adapter.markSettlementBooked.mockClear()
    let now = 0
    // Every acknowledgement takes 10 ms of the 5 ms budget: the first one runs, nothing after it.
    adapter.markSettlementBooked.mockImplementation(async () => {
      now += 10
      return null
    })
    const summary = await runSettlementSync(deps(), { importAll: true, budgetMs: 5, clock: () => now })
    // Deferred: the bank row lookup of the booked payout and the connection's import.
    expect(summary).toMatchObject({ acknowledged: 1, imported: 0, deferred: 2 })
    expect(adapter.settlements).not.toHaveBeenCalled()
  })
})

describe('the provider test payouts of 2026-10-14, imported and booked', () => {
  /** A sample payout on the seeded case and invoice, whose capital the seeded collected payment booked. */
  function onSeededCase(ref: string): CollectionsSettlement {
    const sample = SAMPLE_SETTLEMENTS.find((settlement) => settlement.settlementRef === ref)!
    const principal = sumOre(sample.lines.filter((line) => line.kind === 'principal').map((line) => line.amount))
    mem.rows('collection_collected_payments')[0]!.capital_paid = principal
    return { ...sample, lines: sample.lines.map((line) => ({ ...line, caseRef: 'claim-1', invoiceRef: INVOICE })) }
  }

  function offer(settlement: CollectionsSettlement) {
    const { settlementRef, paymentDate, amount, currency, statusOk } = settlement
    adapter.settlements.mockResolvedValue([{ settlementRef, paymentDate, amount, currency, statusOk }])
    adapter.settlement.mockResolvedValue(settlement)
  }

  it('a payout of principal only books on its own where automatic booking is on; the payout line is stored, never booked', async () => {
    seedWorld({ autoBookSettlements: true })
    offer(onSeededCase('1000000216'))
    expect(await runSettlementSync(deps({ vatInvoiceAccepted: undefined }), { importAll: true })).toMatchObject({ imported: 1, booked: 1, needsMapping: 0 })
    const input = vi.mocked(createJournalEntry).mock.calls[0]![3]
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 12500, 0],
      ['1689', 0, 12500],
    ])
    const lines = mem.rows('collection_settlement_lines').sort((a, b) => Number(a.position) - Number(b.position))
    expect(lines.map((l) => [l.kind, l.in_payout, l.amount, l.case_id, l.booked === true])).toEqual([
      ['principal', true, 12500, CASE, true],
      ['informational', false, 12500, CASE, false],
    ])
    expect(mem.rows('collection_collected_payments')[0]).toMatchObject({ settlement_id: mem.rows('collection_settlements')[0]!.id })
  })

  it.each([
    [true, '2641'],
    [false, '6062'],
  ])('the VAT pair waits for a person even with automatic booking on (VAT-registered %s), then books as chosen on %s', async (vatRegistered, account) => {
    seedWorld({ autoBookSettlements: true, vatRegistered })
    offer(onSeededCase('1000000220'))
    expect(await runSettlementSync(deps({ vatInvoiceAccepted: undefined }), { importAll: true })).toMatchObject({ imported: 1, booked: 0, needsMapping: 1 })
    expect(createJournalEntry).not.toHaveBeenCalled()
    const id = mem.rows('collection_settlements')[0]!.id as string
    expect(settlementRow(id)).toMatchObject({ status: 'needs_mapping', needs_mapping_reason: 'vat_unconfirmed' })

    for (const vatLine of mem.rows('collection_settlement_lines').filter((l) => l.kind === 'agency_fee_vat')) {
      Object.assign(vatLine, { account_number: account, account_chosen_by: USER })
    }
    expect(await bookSettlement(deps({ vatInvoiceAccepted: undefined }), COMPANY, id, { userId: USER })).toMatchObject({ ok: true })
    const input = vi.mocked(createJournalEntry).mock.calls[0]![3]
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 1890, 0],
      ['1689', 0, 1900],
      [account, 50, 0],
      [account, 0, 40],
    ])
  })
})

describe('the provider test payout over several claims (1000000225), imported', () => {
  // The company's invoices of the merged case: the parent (its first invoice) and the two children.
  const PARENT_INVOICE = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e21'
  const CHILD_12 = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e22'
  const CHILD_13 = '6f1c2a40-3b7e-4d1a-9c55-0a1b2c3d4e23'
  const OWN: Record<string, string> = {
    'qa-settle-inv-20261014-11': PARENT_INVOICE,
    'qa-settle-inv-20261014-12': CHILD_12,
    'qa-settle-inv-20261014-13': CHILD_13,
  }

  /** The sample with the company's own invoice ids in place of the test environment's refs. */
  function sample(): CollectionsSettlement {
    const own = (ref: string) => OWN[ref] ?? ref
    return {
      ...SAMPLE_MULTI_CLAIM_SETTLEMENT,
      lines: SAMPLE_MULTI_CLAIM_SETTLEMENT.lines.map((line) => ({
        ...line,
        invoiceRef: line.invoiceRef ? own(line.invoiceRef) : null,
        originalInvoiceRefs: line.originalInvoiceRefs.map(own),
      })),
    }
  }

  function seedMergedCase(collected: Array<[caseId: string, invoiceId: string, capital: number]>) {
    mem.seed('invoices', [
      { id: PARENT_INVOICE, company_id: COMPANY },
      { id: CHILD_12, company_id: COMPANY },
      { id: CHILD_13, company_id: COMPANY },
    ])
    mem.seed('collection_cases', [
      { id: 'case-11', company_id: COMPANY, invoice_id: PARENT_INVOICE, connection_id: CONNECTION, provider_case_ref: '205627', submission_status: 'registered', created_at: '2026-10-14T00:00:00Z' },
      { id: 'case-12', company_id: COMPANY, invoice_id: CHILD_12, connection_id: CONNECTION, provider_case_ref: '205628', submission_status: 'registered', created_at: '2026-10-14T00:00:00Z' },
      { id: 'case-13', company_id: COMPANY, invoice_id: CHILD_13, connection_id: CONNECTION, provider_case_ref: '205629', submission_status: 'registered', created_at: '2026-10-14T00:00:00Z' },
    ])
    mem.seed(
      'collection_collected_payments',
      collected.map(([caseId, invoiceId, capital]) => ({
        id: `collected-${caseId}`,
        company_id: COMPANY,
        case_id: caseId,
        invoice_id: invoiceId,
        provider_payment_ref: `pay-${caseId}`,
        paid_at: '2026-10-14',
        capital_paid: capital,
        status: 'booked',
        invoice_payment_id: `ip-${caseId}`,
        journal_entry_id: `je-${caseId}`,
        settlement_id: null,
      })),
    )
  }

  const stored = () =>
    mem
      .rows('collection_settlement_lines')
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((l) => [l.position, l.kind, l.case_id, l.invoice_id, l.original_invoice_ids])

  it('places the merged case\'s capital on its own invoices and holds the capital of claims that are not the company\'s for a person', async () => {
    seedWorld({ autoBookSettlements: true })
    seedMergedCase([
      ['case-13', CHILD_13, 2500],
      ['case-12', CHILD_12, 1500],
    ])
    const id = await storedSettlement(sample())
    const merged = [PARENT_INVOICE, CHILD_12, CHILD_13]
    expect(stored()).toEqual([
      [0, 'principal', 'case-13', CHILD_13, []],
      [1, 'principal', 'case-12', CHILD_12, []],
      // The claims the provider's staff created: no case and no invoice of the company's.
      [2, 'principal', null, null, []],
      [3, 'principal', null, null, []],
      [4, 'cost_refund_to_creditor', null, null, []],
      [5, 'informational', null, null, merged],
      [6, 'informational', null, null, []],
      [7, 'informational', null, null, []],
      [8, 'agency_fee_vat', null, null, merged],
      [9, 'agency_fee_vat', null, null, merged],
    ])

    expect(await bookSettlement(deps({ vatInvoiceAccepted: undefined }), COMPANY, id, { userId: USER })).toMatchObject({
      ok: false,
      outcome: 'needs_mapping',
      reason: 'unknown_case',
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(settlementRow(id)).toMatchObject({ status: 'needs_mapping', needs_mapping_reason: 'unknown_case' })

    // A person placing the VAT pair does not place capital the company has no case for.
    const preview = await previewSettlementVoucher(deps({ vatInvoiceAccepted: undefined }), COMPANY, id, [
      { position: 8, accountNumber: '2641' },
      { position: 9, accountNumber: '2641' },
    ])
    expect(preview).toMatchObject({ ok: false, reason: 'unknown_case' })
    expect(preview!.ok === false && preview!.issues).toEqual([
      { reason: 'unknown_case', position: 2 },
      { reason: 'unknown_case', position: 3 },
    ])
    for (const row of mem.rows('collection_collected_payments')) expect(row.settlement_id ?? null).toBeNull()
  })

  it('capital the debtor pays on the parent invoice itself is placed on the parent\'s case, never on its children', async () => {
    seedWorld()
    seedMergedCase([
      ['case-11', PARENT_INVOICE, 4000],
      ['case-12', CHILD_12, 1500],
    ])
    const parentCapital: CollectionsSettlementLine = {
      ...SAMPLE_MULTI_CLAIM_SETTLEMENT.lines[0]!,
      amount: 4000,
      caseRef: '205627',
      invoiceRef: PARENT_INVOICE,
    }
    const id = await storedSettlement({
      ...sample(),
      settlementRef: '1000000225-parent',
      amount: 5500,
      lines: [parentCapital, sample().lines[1]!, { ...sample().lines[5]!, amount: 5500 }],
    })
    expect(stored()).toEqual([
      [0, 'principal', 'case-11', PARENT_INVOICE, []],
      [1, 'principal', 'case-12', CHILD_12, []],
      [2, 'informational', null, null, [PARENT_INVOICE, CHILD_12, CHILD_13]],
    ])
    expect(await bookSettlement(deps(), COMPANY, id, { userId: USER })).toMatchObject({ ok: true })
    expect(vi.mocked(createJournalEntry).mock.calls[0]![3].lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 5500, 0],
      ['1689', 0, 4000],
      ['1689', 0, 1500],
    ])
    const settled = mem.rows('collection_collected_payments').filter((row) => row.settlement_id === id).map((row) => row.id)
    expect(settled.sort()).toEqual(['collected-case-11', 'collected-case-12'])
  })
})
