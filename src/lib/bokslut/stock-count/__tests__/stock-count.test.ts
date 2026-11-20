import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const mocks = vi.hoisted(() => ({
  postJournalEntry: vi.fn(),
  generateTrialBalance: vi.fn(),
  linkToJournalEntry: vi.fn(),
  uploadDocument: vi.fn(),
  setChecklistItem: vi.fn(),
}))

vi.mock('@/lib/posting/port', () => ({ postingPort: { postJournalEntry: mocks.postJournalEntry } }))
vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: mocks.generateTrialBalance }))
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/documents/document-service')>()),
  linkToJournalEntry: mocks.linkToJournalEntry,
  uploadDocument: mocks.uploadDocument,
}))
vi.mock('@/lib/bokslut/checklist', () => ({ setChecklistItem: mocks.setChecklistItem }))

import { createStockCount, deleteStockCount, updateStockCount, type StockCountRecord } from '../register'
import { bookStockCount, previewStockCountBooking } from '../booking'
import { signStockCountManually, syncStockCountSigning } from '../signing'
import { StockCountError } from '../errors'

const COMPANY = 'company-1'
const USER = 'user-1'
const PERIOD = { id: '3f6c2a1e-8b4d-4c2e-9a71-5d0e6b7c8a90', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }

function record(overrides: Partial<StockCountRecord> = {}): StockCountRecord {
  return {
    id: 'count-1',
    company_id: COMPANY,
    fiscal_period_id: PERIOD.id,
    balance_date: '2026-12-31',
    count_date: '2026-12-31',
    roll_forward_note: null,
    note: null,
    status: 'draft',
    signer_name: null,
    signed_at: null,
    signed_document_id: null,
    signing_request_id: null,
    journal_entry_id: null,
    booked_at: null,
    created_at: '2027-01-02T08:00:00Z',
    updated_at: '2027-01-02T08:00:00Z',
    ...overrides,
  }
}

const ROW = {
  id: 'row-1', position: 1, article_id: null, description: 'Kaffe', category: 'goods_for_resale', unit: 'st',
  quantity: 10, unit_cost: 100, write_down_percent: 10, value: 900,
}

const client = (mock: ReturnType<typeof createTableMockSupabase>) => mock.supabase as unknown as SupabaseClient

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof StockCountError) return err.code
    throw err
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createStockCount', () => {
  it('makes a draft on the year\'s balansdag and values every row in öre', async () => {
    const mock = createTableMockSupabase({
      fiscal_periods: { data: PERIOD },
      inventory_counts: { data: record() },
      inventory_count_rows: [{ data: null }, { data: [ROW] }],
    })
    const view = await createStockCount(client(mock), COMPANY, USER, {
      fiscal_period_id: PERIOD.id,
      count_date: '2026-12-31',
      rows: [{ description: 'Kaffe', quantity: 10, unit_cost: 100, write_down_percent: 10, unit: 'st' }],
    })
    expect(mock.payloads('inventory_counts', 'insert')).toEqual([
      expect.objectContaining({ company_id: COMPANY, user_id: USER, fiscal_period_id: PERIOD.id, balance_date: '2026-12-31', roll_forward_note: null }),
    ])
    expect(mock.payloads('inventory_count_rows', 'insert')).toEqual([
      [expect.objectContaining({ position: 1, description: 'Kaffe', category: 'goods_for_resale', value: 900, company_id: COMPANY })],
    ])
    expect(view.total_value).toBe(900)
    expect(view.totals).toEqual([{ category: 'goods_for_resale', cost: 1000, write_down: 100, value: 900, rows: 1 }])
  })

  it('needs the roll-forward when the stock was counted on another day', async () => {
    const mock = createTableMockSupabase({ fiscal_periods: { data: PERIOD } })
    expect(
      await refusal(createStockCount(client(mock), COMPANY, USER, { fiscal_period_id: PERIOD.id, count_date: '2027-01-04', rows: [] })),
    ).toBe('STOCK_COUNT_ROLL_FORWARD_REQUIRED')
    expect(mock.findCalls('inventory_counts', 'insert')).toEqual([])
  })

  it('refuses a fiscal year that is not the company\'s and an unknown article', async () => {
    const none = createTableMockSupabase({ fiscal_periods: { data: null } })
    expect(
      await refusal(createStockCount(client(none), COMPANY, USER, { fiscal_period_id: PERIOD.id, count_date: '2026-12-31', rows: [] })),
    ).toBe('STOCK_COUNT_NO_PERIOD')
    const noArticle = createTableMockSupabase({ fiscal_periods: { data: PERIOD }, articles: { data: [] } })
    expect(
      await refusal(createStockCount(client(noArticle), COMPANY, USER, {
        fiscal_period_id: PERIOD.id,
        count_date: '2026-12-31',
        rows: [{ description: 'X', quantity: 1, unit_cost: 1, article_id: '7b0e8a5e-9a43-4a5e-9b3a-0f6f6a0b8c11' }],
      })),
    ).toBe('STOCK_COUNT_ARTICLE_NOT_FOUND')
  })
})

describe('updateStockCount and deleteStockCount', () => {
  const body = { fiscal_period_id: PERIOD.id, count_date: '2026-12-31', rows: [] }

  it('refuse a signed count and a count out for BankID signing', async () => {
    const signed = createTableMockSupabase({ inventory_counts: { data: record({ status: 'signed', signer_name: 'A', signed_at: 'x' }) } })
    expect(await refusal(updateStockCount(client(signed), COMPANY, 'count-1', body))).toBe('STOCK_COUNT_LOCKED')
    expect(await refusal(deleteStockCount(client(signed), COMPANY, 'count-1'))).toBe('STOCK_COUNT_LOCKED')
    const pending = createTableMockSupabase({ inventory_counts: { data: record({ signing_request_id: 'sr-1' }) } })
    expect(await refusal(updateStockCount(client(pending), COMPANY, 'count-1', body))).toBe('STOCK_COUNT_SIGNING_PENDING')
  })

  it('replaces a draft\'s rows', async () => {
    const mock = createTableMockSupabase({
      inventory_counts: [{ data: record() }, { data: record({ note: 'Lager Malmö' }) }],
      fiscal_periods: { data: PERIOD },
      inventory_count_rows: [{ data: null }, { data: null }, { data: [ROW] }],
    })
    const view = await updateStockCount(client(mock), COMPANY, 'count-1', {
      ...body,
      note: 'Lager Malmö',
      rows: [{ description: 'Kaffe', quantity: 10, unit_cost: 100, write_down_percent: 10 }],
    })
    expect(mock.findCalls('inventory_count_rows', 'delete')).toHaveLength(1)
    expect(mock.payloads('inventory_count_rows', 'insert')).toHaveLength(1)
    expect(view.note).toBe('Lager Malmö')
  })
})

describe('signStockCountManually', () => {
  it('signs a draft with name and day, and marks the checklist step done', async () => {
    const signed = record({ status: 'signed', signer_name: 'Anna Svensson', signed_at: '2027-01-03T11:00:00.000Z' })
    const mock = createTableMockSupabase({
      inventory_counts: [{ data: record() }, { data: signed }],
      inventory_count_rows: { data: [ROW] },
    })
    mocks.uploadDocument.mockResolvedValue({ id: 'doc-1' })
    const view = await signStockCountManually(client(mock), COMPANY, USER, 'count-1', {
      signerName: ' Anna Svensson ',
      signedOn: '2027-01-03',
      file: { name: 'lista.pdf', buffer: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer, type: 'application/pdf' },
    })
    expect(view.status).toBe('signed')
    expect(mock.payloads('inventory_counts', 'update')).toEqual([
      expect.objectContaining({ status: 'signed', signer_name: 'Anna Svensson', signed_document_id: 'doc-1' }),
    ])
    expect(mocks.uploadDocument).toHaveBeenCalledWith(expect.anything(), USER, COMPANY, expect.objectContaining({ name: 'lista.pdf' }), expect.objectContaining({ extractionOwner: 'none' }))
    expect(mocks.setChecklistItem).toHaveBeenCalledWith(expect.anything(), COMPANY, USER, PERIOD.id, expect.objectContaining({ item_key: 'inventory_valued', state: 'done' }))
  })

  it('refuses an empty list', async () => {
    const mock = createTableMockSupabase({ inventory_counts: { data: record() }, inventory_count_rows: { data: [] } })
    expect(await refusal(signStockCountManually(client(mock), COMPANY, USER, 'count-1', { signerName: 'A', signedOn: '2027-01-03' }))).toBe('STOCK_COUNT_EMPTY')
  })
})

describe('syncStockCountSigning', () => {
  it('signs the count when its BankID request completed, with the BankID name', async () => {
    const pending = record({ signing_request_id: 'sr-1' })
    const mock = createTableMockSupabase({
      signing_requests: { data: { status: 'completed', expires_at: '2027-02-01T00:00:00Z', completed_at: '2027-01-03T10:00:00Z', signed_document_id: 'doc-signed' } },
      signing_request_signers: { data: { name: 'Anna', bankid_given_name: 'Anna Maria', bankid_surname: 'Svensson', signed_at: '2027-01-03T10:00:00Z' } },
      inventory_counts: { data: { ...pending, status: 'signed', signer_name: 'Anna Maria Svensson', signed_at: '2027-01-03T10:00:00Z', signed_document_id: 'doc-signed' } },
    })
    const next = await syncStockCountSigning(client(mock), COMPANY, USER, pending)
    expect(next.status).toBe('signed')
    expect(mock.payloads('inventory_counts', 'update')).toEqual([
      { status: 'signed', signer_name: 'Anna Maria Svensson', signed_at: '2027-01-03T10:00:00Z', signed_document_id: 'doc-signed' },
    ])
    expect(mocks.setChecklistItem).toHaveBeenCalled()
  })

  it('opens the draft again when the request was cancelled', async () => {
    const pending = record({ signing_request_id: 'sr-1' })
    const mock = createTableMockSupabase({
      signing_requests: { data: { status: 'cancelled', expires_at: '2027-02-01T00:00:00Z', completed_at: null, signed_document_id: null } },
      inventory_counts: { data: record() },
    })
    await syncStockCountSigning(client(mock), COMPANY, USER, pending)
    expect(mock.payloads('inventory_counts', 'update')).toEqual([{ signing_request_id: null }])
    expect(mocks.setChecklistItem).not.toHaveBeenCalled()
  })

  it('leaves a count without a request alone', async () => {
    const mock = createTableMockSupabase()
    const r = record()
    expect(await syncStockCountSigning(client(mock), COMPANY, USER, r)).toBe(r)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })
})

describe('booking the lagerförändring', () => {
  const signed = record({ status: 'signed', signer_name: 'Anna', signed_at: '2027-01-03T10:00:00Z', signed_document_id: 'doc-1' })

  beforeEach(() => {
    mocks.generateTrialBalance.mockResolvedValue({
      rows: [
        { account_number: '1460', closing_debit: 700, closing_credit: 0 },
        { account_number: '1930', closing_debit: 5000, closing_credit: 0 },
      ],
    })
  })

  it('previews the counted value per kind against the ledger at balansdagen', async () => {
    const mock = createTableMockSupabase({ inventory_count_rows: { data: [ROW] } })
    const preview = await previewStockCountBooking(client(mock), COMPANY, 'count-1', { record: signed })
    expect(mocks.generateTrialBalance).toHaveBeenCalledWith(expect.anything(), COMPANY, PERIOD.id, { closingEntry: 'include' })
    expect(preview).toMatchObject({ counted_total: 900, ledger_total: 700 })
    expect(preview.adjustments).toEqual([
      { category: 'goods_for_resale', stock_account: '1460', change_account: '4960', counted: 900, ledger: 700, adjustment: 200 },
    ])
  })

  it('books one balanced year_end verifikat through the posting port and marks the count booked', async () => {
    mocks.postJournalEntry.mockResolvedValue({ id: 'je-1', voucher_series: 'A', voucher_number: 42 })
    const booked = { ...signed, status: 'booked', journal_entry_id: 'je-1', booked_at: '2027-01-04T08:00:00Z' }
    const mock = createTableMockSupabase({
      inventory_counts: [{ data: signed }, { data: [] }, { data: booked }],
      inventory_count_rows: { data: [ROW] },
    })
    const result = await bookStockCount(client(mock), COMPANY, USER, 'count-1')
    expect(result.entry?.id).toBe('je-1')
    const request = mocks.postJournalEntry.mock.calls[0]![0]
    expect(request.input).toMatchObject({
      fiscal_period_id: PERIOD.id,
      entry_date: '2026-12-31',
      source_type: 'year_end',
      lines: [
        expect.objectContaining({ account_number: '1460', debit_amount: 200, credit_amount: 0 }),
        expect.objectContaining({ account_number: '4960', debit_amount: 0, credit_amount: 200 }),
      ],
    })
    // The engine takes the company's year_end series (accounted#58).
    expect(request.input).not.toHaveProperty('voucher_series')
    expect(mock.payloads('inventory_counts', 'update')).toEqual([expect.objectContaining({ status: 'booked', journal_entry_id: 'je-1' })])
    expect(mocks.linkToJournalEntry).toHaveBeenCalledWith(expect.anything(), COMPANY, 'doc-1', 'je-1', expect.anything())
  })

  it('posts nothing when the ledger already holds the count, and still marks it booked', async () => {
    mocks.generateTrialBalance.mockResolvedValue({ rows: [{ account_number: '1460', closing_debit: 900, closing_credit: 0 }] })
    const mock = createTableMockSupabase({
      inventory_counts: [{ data: signed }, { data: [] }, { data: { ...signed, status: 'booked' } }],
      inventory_count_rows: { data: [ROW] },
    })
    const result = await bookStockCount(client(mock), COMPANY, USER, 'count-1')
    expect(result.entry).toBeNull()
    expect(mocks.postJournalEntry).not.toHaveBeenCalled()
    expect(mock.payloads('inventory_counts', 'update')).toEqual([expect.objectContaining({ status: 'booked', journal_entry_id: null })])
  })

  it('refuses an unsigned count, a booked count, and a year already booked', async () => {
    expect(await refusal(bookStockCount(client(createTableMockSupabase({ inventory_counts: { data: record() } })), COMPANY, USER, 'count-1'))).toBe('STOCK_COUNT_NOT_SIGNED')
    expect(await refusal(bookStockCount(client(createTableMockSupabase({ inventory_counts: { data: { ...signed, status: 'booked' } } })), COMPANY, USER, 'count-1'))).toBe('STOCK_COUNT_ALREADY_BOOKED')
    const other = createTableMockSupabase({ inventory_counts: [{ data: signed }, { data: [{ id: 'count-0' }] }] })
    expect(await refusal(bookStockCount(client(other), COMPANY, USER, 'count-1'))).toBe('STOCK_COUNT_ALREADY_BOOKED')
    expect(mocks.postJournalEntry).not.toHaveBeenCalled()
  })
})
