import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from '@/lib/pos-sales/__tests__/fake-db'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  createDraftEntry: vi.fn(),
  commitEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  checkPeriodLock: vi.fn(),
  findUnresolvableAccounts: vi.fn(),
  uploadDocument: vi.fn(),
  renderDay: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createDraftEntry: h.createDraftEntry,
  commitEntry: h.commitEntry,
  findFiscalPeriod: h.findFiscalPeriod,
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: h.checkPeriodLock }))
vi.mock('@/lib/bookkeeping/account-validation', () => ({ findUnresolvableAccounts: h.findUnresolvableAccounts }))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: h.uploadDocument }))
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({ ensureWebshopPrefillAccounts: vi.fn(async () => undefined) }))
vi.mock('../day-underlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../day-underlag')>()),
  renderWebshopDayUnderlagPdf: h.renderDay,
}))

import { bookWebshopDay, sumDayLines } from '../book-day'

const COMPANY = 'company-1'
const DAY = '2026-10-14'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

let seq = 0
function order(overrides: Record<string, unknown> = {}) {
  seq += 1
  return {
    id: `order-${seq}`,
    company_id: COMPANY,
    platform: 'shopify',
    store_scope: 'butik.myshopify.com',
    store_label: 'Butiken',
    row_type: 'order',
    parent_order_id: null,
    order_number: `#10${seq}`,
    status: 'paid',
    is_paid: true,
    order_date: DAY,
    paid_date: DAY,
    currency: 'SEK',
    total: 125,
    total_tax: 25,
    total_sek: 125,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 100, tax: 25 }],
    line_items: [],
    customer_country: 'SE',
    payment_method: 'shopify_payments',
    payment_method_title: 'shopify_payments',
    journal_entry_id: null,
    invoice_id: null,
    manually_booked_at: null,
    legacy_transaction_id: null,
    created_at: `${DAY}T10:0${seq % 10}:00Z`,
    ...overrides,
  }
}

function refund(parentId: string, overrides: Record<string, unknown> = {}) {
  return order({
    row_type: 'refund',
    parent_order_id: parentId,
    status: 'refund',
    total: -50,
    total_tax: -10,
    total_sek: -50,
    vat_breakdown: [{ rate: 25, net: 40, tax: 10 }],
    ...overrides,
  })
}

function seed(rows: Record<string, unknown>[]) {
  h.db = createFakeDb({
    webshop_orders: rows,
    webshop_store_settings: [],
    company_settings: [{ company_id: COMPANY, company_name: 'Exempel AB', org_number: '556677-8899' }],
    journal_entries: [],
  })
}

function ctx() {
  return { supabase: h.db.client as never, companyId: COMPANY, userId: 'user-1', log }
}

const INPUT = { platform: 'shopify' as const, store_scope: 'butik.myshopify.com', date: DAY, payment_method: 'shopify_payments' }

function row(id: string) {
  return h.db.tables.webshop_orders.find((r) => r.id === id)!
}

beforeEach(() => {
  vi.clearAllMocks()
  seq = 0
  h.checkPeriodLock.mockResolvedValue({ locked: false })
  h.findFiscalPeriod.mockResolvedValue('fp-2026')
  h.findUnresolvableAccounts.mockResolvedValue([])
  h.createDraftEntry.mockImplementation(async () => {
    h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
    return { id: 'je-1' }
  })
  h.commitEntry.mockResolvedValue({ id: 'je-1', voucher_series: 'L', voucher_number: 41, entry_date: DAY })
  h.renderDay.mockResolvedValue({ bytes: new Uint8Array([37, 80, 68, 70]), filename: 'Dagssammanstallning_Shopify_2026-10-14_shopify_payments.pdf' })
  h.uploadDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('sumDayLines', () => {
  it('sums every order per account and side, debits first, and stays balanced', () => {
    const lines = sumDayLines(
      [
        [
          { account_number: '1686', debit_amount: 125, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 100 },
          { account_number: '2611', debit_amount: 0, credit_amount: 25 },
        ],
        [
          { account_number: '1686', debit_amount: 0.3, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 0.1 },
          { account_number: '2611', debit_amount: 0, credit_amount: 0.2 },
        ],
        // A refund: the reverse sides, kept apart from the sales.
        [
          { account_number: '3001', debit_amount: 40, credit_amount: 0 },
          { account_number: '2611', debit_amount: 10, credit_amount: 0 },
          { account_number: '1686', debit_amount: 0, credit_amount: 50 },
        ],
      ],
      'Dag',
    )
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1686', 125.3, 0],
      ['2611', 10, 0],
      ['3001', 40, 0],
      ['1686', 0, 50],
      ['2611', 0, 25.2],
      ['3001', 0, 100.1],
    ])
    const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    expect(lines.every((l) => l.line_description === 'Dag')).toBe(true)
  })
})

describe('bookWebshopDay', () => {
  it('books the day and payment method as one verifikat, links every row and archives the summary', async () => {
    const a = order()
    const b = order({ total: 250, total_tax: 50, total_sek: 250, vat_breakdown: [{ rate: 25, net: 200, tax: 50 }] })
    const r = refund(a.id)
    const otherMethod = order({ payment_method: 'paypal' })
    const otherDay = order({ paid_date: '2026-10-15', order_date: '2026-10-15' })
    const booked = order({ journal_entry_id: 'je-old' })
    seed([a, b, r, otherMethod, otherDay, booked])

    const outcome = await bookWebshopDay(ctx(), INPUT)

    expect(outcome).toMatchObject({
      ok: true,
      data: { journal_entry_id: 'je-1', voucher_series: 'L', voucher_number: 41, entry_date: DAY, skipped: [], underlag_document_id: 'doc-1' },
    })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a booking')
    expect(outcome.data.booked.map((o) => o.webshop_order_id)).toEqual([a.id, b.id, r.id])

    expect(h.createDraftEntry).toHaveBeenCalledTimes(1)
    const input = h.createDraftEntry.mock.calls[0][3]
    expect(input).toMatchObject({
      fiscal_period_id: 'fp-2026',
      entry_date: DAY,
      source_type: 'webshop_order',
      description: 'Dagsförsäljning 2026-10-14 Butiken (shopify_payments)',
    })
    expect(input.source_id).toBeUndefined()
    expect(input.lines.map((l: { account_number: string; debit_amount: number; credit_amount: number }) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1686', 375, 0],
      ['2611', 10, 0],
      ['3001', 40, 0],
      ['1686', 0, 50],
      ['2611', 0, 75],
      ['3001', 0, 300],
    ])

    for (const id of [a.id, b.id, r.id]) expect(row(id).journal_entry_id).toBe('je-1')
    expect(row(otherMethod.id).journal_entry_id).toBeNull()
    expect(row(otherDay.id).journal_entry_id).toBeNull()
    expect(row(booked.id).journal_entry_id).toBe('je-old')

    const upload = h.uploadDocument.mock.calls[0]
    expect(upload[3].name).toBe('Dagssammanstallning_Shopify_2026-10-14_shopify_payments.pdf')
    expect(upload[4]).toMatchObject({ upload_source: 'system', journal_entry_id: 'je-1', extractionOwner: 'none' })
  })

  it('previews on a dry run with the rows to pin and writes nothing', async () => {
    const a = order()
    seed([a])
    const outcome = await bookWebshopDay(ctx(), INPUT, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { order_ids: [a.id], date: DAY, store_label: 'Butiken' } })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
    expect(row(a.id).journal_entry_id).toBeNull()
  })

  it('takes a row without a paid date on its order date', async () => {
    const a = order({ paid_date: null })
    seed([a])
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({ ok: true })
    expect(row(a.id).journal_entry_id).toBe('je-1')
  })

  it('leaves out an order that needs review, reports it, and books the rest', async () => {
    const a = order()
    const noSplit = order({ vat_breakdown: [] })
    seed([a, noSplit])
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({
      ok: true,
      data: { skipped: [{ webshop_order_id: noSplit.id, code: 'WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING' }] },
      warnings: [{ code: 'WEBSHOP_DAY_ORDERS_SKIPPED' }],
    })
    expect(row(a.id).journal_entry_id).toBe('je-1')
    expect(row(noSplit.id).journal_entry_id).toBeNull()
  })

  it('refuses when no order of the day can be booked unattended', async () => {
    seed([order({ vat_breakdown: [] })])
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_NOTHING_BOOKABLE' })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('refuses an empty day', async () => {
    seed([order({ payment_method: 'paypal' })])
    expect(await bookWebshopDay(ctx(), INPUT)).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_EMPTY' })
  })

  it('refuses when a reviewed row was booked since, and books nothing', async () => {
    const a = order()
    const b = order()
    seed([a, b])
    row(b.id).journal_entry_id = 'je-other'
    const outcome = await bookWebshopDay(ctx(), { ...INPUT, expected_order_ids: [a.id, b.id] })
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { webshop_order_ids: [b.id] } })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
    expect(row(a.id).journal_entry_id).toBeNull()
  })

  it('books only the reviewed rows when an order arrives after the review', async () => {
    const a = order()
    const late = order()
    seed([a, late])
    const outcome = await bookWebshopDay(ctx(), { ...INPUT, expected_order_ids: [a.id] })
    expect(outcome).toMatchObject({ ok: true })
    expect(row(a.id).journal_entry_id).toBe('je-1')
    expect(row(late.id).journal_entry_id).toBeNull()
  })

  it('refuses an approval whose lines differ from the reviewed ones, and books nothing', async () => {
    const a = order()
    seed([a])
    const preview = await bookWebshopDay(ctx(), INPUT, { dryRun: true })
    if (!preview.ok || !preview.dryRun) throw new Error('expected a preview')
    const sha = preview.preview.lines_sha256 as string
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    // The store raises the order after the review.
    Object.assign(row(a.id), { total: 250, total_tax: 50, total_sek: 250, vat_breakdown: [{ rate: 25, net: 200, tax: 50 }] })
    const outcome = await bookWebshopDay(ctx(), { ...INPUT, expected_order_ids: [a.id], expected_lines_sha256: sha })
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_CHANGED' })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('books an approval whose lines are the reviewed ones', async () => {
    const a = order()
    seed([a])
    const preview = await bookWebshopDay(ctx(), INPUT, { dryRun: true })
    if (!preview.ok || !preview.dryRun) throw new Error('expected a preview')
    const outcome = await bookWebshopDay(ctx(), {
      ...INPUT,
      expected_order_ids: [a.id],
      expected_lines_sha256: preview.preview.lines_sha256 as string,
    })
    expect(outcome).toMatchObject({ ok: true })
  })

  it('loses the day to a row the sync changed between its derivation and the claim', async () => {
    const a = order()
    const b = order()
    seed([a, b])
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      Object.assign(row(b.id), { total: 999, total_sek: 999 })
      return { id: 'je-1' }
    })
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { webshop_order_ids: [b.id] } })
    expect(row(a.id).journal_entry_id).toBeNull()
    expect(row(b.id).journal_entry_id).toBeNull()
    expect(h.db.tables.journal_entries.find((e) => e.id === 'je-1')?.status).toBe('cancelled')
    expect(h.commitEntry).not.toHaveBeenCalled()
  })

  it('loses the day to an order the store cancelled between its derivation and the claim', async () => {
    const a = order()
    const b = order()
    seed([a, b])
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      Object.assign(row(b.id), { status: 'cancelled', refunded_total: 0 })
      return { id: 'je-1' }
    })
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_CHANGED', details: { webshop_order_ids: [b.id] } })
    expect(row(b.id).journal_entry_id).toBeNull()
    expect(h.commitEntry).not.toHaveBeenCalled()
  })

  it('keeps the day when an order\'s status moves on without a cancel', async () => {
    const a = order()
    seed([a])
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      Object.assign(row(a.id), { status: 'completed' })
      return { id: 'je-1' }
    })
    expect(await bookWebshopDay(ctx(), INPUT)).toMatchObject({ ok: true })
  })

  it('loses the whole day to a row booked between the read and the claim, and releases every claim', async () => {
    const a = order()
    const b = order()
    seed([a, b])
    h.createDraftEntry.mockImplementation(async () => {
      h.db.tables.journal_entries.push({ id: 'je-1', status: 'draft' })
      row(b.id).journal_entry_id = 'je-race'
      return { id: 'je-1' }
    })
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_CHANGED' })
    expect(row(a.id).journal_entry_id).toBeNull()
    expect(row(b.id).journal_entry_id).toBe('je-race')
    expect(h.db.tables.journal_entries.find((e) => e.id === 'je-1')?.status).toBe('cancelled')
    expect(h.commitEntry).not.toHaveBeenCalled()
  })

  it('releases the claims and cancels the draft when the commit fails', async () => {
    const a = order()
    seed([a])
    h.commitEntry.mockRejectedValue(new Error('commit failed'))
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_DAY_BOOKING_FAILED' })
    expect(row(a.id).journal_entry_id).toBeNull()
    expect(h.db.tables.journal_entries.find((e) => e.id === 'je-1')?.status).toBe('cancelled')
  })

  it('refuses a locked day before drafting', async () => {
    seed([order()])
    h.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked', fiscal_period_id: 'fp-2026' })
    expect(await bookWebshopDay(ctx(), INPUT)).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expect(h.createDraftEntry).not.toHaveBeenCalled()
  })

  it('still books when the summary cannot be archived, with a warning', async () => {
    seed([order()])
    h.renderDay.mockRejectedValue(new Error('render failed'))
    const outcome = await bookWebshopDay(ctx(), INPUT)
    expect(outcome).toMatchObject({
      ok: true,
      data: { journal_entry_id: 'je-1', underlag_document_id: null },
      warnings: [{ code: 'WEBSHOP_DAY_UNDERLAG_NOT_ARCHIVED' }],
    })
  })
})
