import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PosDay } from '@accounted/connect-contract'
import { createFakeDb, type FakeDb } from './fake-db'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  checkPeriodLock: vi.fn(),
  uploadDocument: vi.fn(),
  renderPosDayReport: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => h.db.client }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: h.createDraftEntry,
  commitEntry: h.commitEntry,
  findFiscalPeriod: h.findFiscalPeriod,
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: h.checkPeriodLock }))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: h.uploadDocument }))
vi.mock('../day-report-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../day-report-pdf')>()),
  renderPosDayReport: h.renderPosDayReport,
}))

import { bookPosSalesDay } from '../book-day'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'

const COMPANY = 'company-1'
const SHA = 'a'.repeat(64)
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

function posDay(overrides: Partial<PosDay> = {}): PosDay {
  return {
    businessDate: '2026-09-30',
    currency: 'SEK',
    sales: { net: 100, vat: 12, gross: 112 },
    vatGroups: [{ ratePercent: 12, net: 100, vat: 12, gross: 112 }],
    tenders: [{ kind: 'card', method: 'card', amount: 112, tips: 0, receiptCount: 1 }],
    tips: 0,
    discounts: 0,
    refunds: { count: 0, gross: 0 },
    receiptCount: 1,
    firstReceiptNumber: '1001',
    lastReceiptNumber: '1001',
    firstPaidAt: null,
    lastPaidAt: null,
    categories: [],
    receipts: [],
    issues: [],
    ...overrides,
  }
}

function seed(dayOverrides: Record<string, unknown> = {}, model?: PosDay) {
  h.db = createFakeDb({
    pos_sales_days: [
      {
        id: 'day-1',
        company_id: COMPANY,
        connection_id: 'conn-1',
        business_date: '2026-09-30',
        currency: 'SEK',
        status: 'ready',
        review_reasons: [],
        gross: '112.00',
        net: '100.00',
        vat: '12.00',
        tips: '0.00',
        receipt_count: 1,
        tenders: [],
        vat_groups: [],
        raw_sha256: SHA,
        fetched_at: '2026-10-01T04:15:00Z',
        fetch_count: 1,
        changed_after_booking: false,
        journal_entry_id: null,
        day: model ?? posDay(),
        ...dayOverrides,
      },
    ],
    pos_connections: [
      { id: 'conn-1', company_id: COMPANY, provider: 'heynow', provider_name: 'Heynow', venue_ref: 'v', venue_name: 'Restaurang Exempel', settings: {}, status: 'active' },
    ],
    company_settings: [{ company_id: COMPANY, company_name: 'Exempel AB', org_number: '556677-8899' }],
    journal_entries: [],
  })
}

function ctx() {
  return { supabase: h.db.client as never, companyId: COMPANY, userId: 'user-1', log }
}

beforeEach(() => {
  vi.clearAllMocks()
  seed()
  h.checkPeriodLock.mockResolvedValue({ locked: false })
  h.findFiscalPeriod.mockResolvedValue('fp-2026')
  h.createDraftEntry.mockImplementation(async () => {
    h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
    return { id: 'je-1' }
  })
  h.commitEntry.mockResolvedValue({ id: 'je-1', voucher_series: 'F', voucher_number: 12, entry_date: '2026-09-30' })
  h.renderPosDayReport.mockResolvedValue(Buffer.from('%PDF-1.4'))
  h.uploadDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('bookPosSalesDay', () => {
  it('books the day through the engine as pos_daily_sales, claims the row, and archives the report', async () => {
    const outcome = await bookPosSalesDay(ctx(), { day_id: 'day-1', expected_raw_sha256: SHA })
    expect(outcome).toMatchObject({
      ok: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'F', voucher_number: 12, business_date: '2026-09-30', gross: 112, underlag_document_id: 'doc-1' },
    })
    const input = h.createDraftEntry.mock.calls[0][3]
    expect(input).toMatchObject({
      fiscal_period_id: 'fp-2026',
      entry_date: '2026-09-30',
      source_type: 'pos_daily_sales',
      source_id: 'day-1',
      description: 'Dagskassa 2026-09-30 Restaurang Exempel (Heynow)',
    })
    expect(input.lines).toEqual([
      { account_number: '1686', debit_amount: 112, credit_amount: 0, line_description: 'Kortbetalningar' },
      { account_number: '3002', debit_amount: 0, credit_amount: 100, line_description: 'Försäljning 12 % moms' },
      { account_number: '2621', debit_amount: 0, credit_amount: 12, line_description: 'Utgående moms 12 %' },
    ])
    expect(h.db.tables.pos_sales_days[0]).toMatchObject({ journal_entry_id: 'je-1', status: 'booked', booked_by: 'user-1' })
    const upload = h.uploadDocument.mock.calls[0]
    expect(upload[3].name).toBe('Dagsrapport_kassa_Restaurang_Exempel_2026-09-30.pdf')
    expect(upload[4]).toMatchObject({ upload_source: 'system', journal_entry_id: 'je-1', extractionOwner: 'none' })
  })

  it('previews on a dry run and writes nothing', async () => {
    const outcome = await bookPosSalesDay(ctx(), { day_id: 'day-1' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { raw_sha256: SHA, business_date: '2026-09-30' } })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
    expect(h.db.updates).toEqual([])
  })

  it('refuses a booked day, a day that changed since review, an empty day, and an unknown day', async () => {
    seed({ journal_entry_id: 'je-0', status: 'booked' })
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({ ok: false, code: 'POS_DAY_ALREADY_BOOKED' })
    seed()
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1', expected_raw_sha256: 'b'.repeat(64) })).toMatchObject({
      ok: false,
      code: 'POS_DAY_CHANGED',
    })
    seed({}, posDay({ sales: { net: 0, vat: 0, gross: 0 }, vatGroups: [], tenders: [] }))
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({ ok: false, code: 'POS_DAY_EMPTY' })
    expect(await bookPosSalesDay(ctx(), { day_id: 'nope' })).toMatchObject({ ok: false, code: 'POS_DAY_NOT_FOUND' })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses provider issues until a person acknowledges them, and a missing account always', async () => {
    seed({}, posDay({ issues: [{ code: 'prepaid_present', message: 'Förbetalda belopp finns' }] }))
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({
      ok: false,
      code: 'POS_DAY_NEEDS_REVIEW',
      details: { acknowledgeable: true },
    })
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1', acknowledge_issues: true })).toMatchObject({ ok: true })

    seed({}, posDay({ tenders: [{ kind: 'invoice', method: 'faktura', amount: 112, tips: 0, receiptCount: 1 }] }))
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1', acknowledge_issues: true })).toMatchObject({
      ok: false,
      code: 'POS_DAY_NEEDS_REVIEW',
      details: { acknowledgeable: false },
    })
  })

  it('refuses a locked date before drafting anything', async () => {
    h.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'company_lock_date_covers' })
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('answers already booked when the live-voucher index refuses the draft', async () => {
    h.createDraftEntry.mockRejectedValue(new BookkeepingDatabaseError('create_draft_entry', 'duplicate key', '23505'))
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({ ok: false, code: 'POS_DAY_ALREADY_BOOKED' })
  })

  it('cancels its draft when another booking claimed the day first', async () => {
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      // The other request claims between our draft and our claim.
      h.db.tables.pos_sales_days[0].journal_entry_id = 'je-other'
      return { id: 'je-1' }
    })
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({
      ok: false,
      code: 'POS_DAY_ALREADY_BOOKED',
      details: { journal_entry_id: 'je-other' },
    })
    expect(h.db.tables.journal_entries[0].status).toBe('cancelled')
    expect(h.commitEntry).not.toHaveBeenCalled()
  })

  it('cancels its draft when a newer fetch replaced the day between the read and the claim', async () => {
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      h.db.tables.pos_sales_days[0].raw_sha256 = 'c'.repeat(64)
      return { id: 'je-1' }
    })
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({ ok: false, code: 'POS_DAY_CHANGED' })
    expect(h.db.tables.journal_entries[0].status).toBe('cancelled')
  })

  it('unlinks the day and cancels the draft when the commit fails', async () => {
    h.commitEntry.mockRejectedValue(new Error('commit_journal_entry failed'))
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({ ok: false, code: 'POS_DAY_BOOKING_FAILED' })
    expect(h.db.tables.pos_sales_days[0]).toMatchObject({ journal_entry_id: null, status: 'ready' })
    expect(h.db.tables.journal_entries[0].status).toBe('cancelled')
  })

  it('finishes the booking when the commit posted but its answer was lost', async () => {
    h.commitEntry.mockImplementation(async () => {
      Object.assign(h.db.tables.journal_entries[0], { status: 'posted', voucher_series: 'F', voucher_number: 13 })
      throw new Error('fetch failed')
    })
    expect(await bookPosSalesDay(ctx(), { day_id: 'day-1' })).toMatchObject({
      ok: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'F', voucher_number: 13 },
    })
    expect(h.db.tables.pos_sales_days[0]).toMatchObject({ journal_entry_id: 'je-1', status: 'booked' })
    expect(h.db.tables.journal_entries[0].status).toBe('posted')
  })

  it('keeps the booking when the report cannot be archived, and says so', async () => {
    h.uploadDocument.mockRejectedValue(new Error('storage down'))
    const outcome = await bookPosSalesDay(ctx(), { day_id: 'day-1' })
    expect(outcome).toMatchObject({ ok: true, data: { underlag_document_id: null } })
    expect((outcome as { warnings?: Array<{ code: string }> }).warnings?.[0].code).toBe('POS_DAY_UNDERLAG_NOT_ARCHIVED')
    expect(h.db.tables.pos_sales_days[0]).toMatchObject({ status: 'booked' })
  })
})
