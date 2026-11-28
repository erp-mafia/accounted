/**
 * The machine doors (v1 and MCP, lib/operations/webshop-orders.ts) on an
 * order a plain storno released from its verifikat (isWebshopBookingReleased):
 * the list and the read say it is to book, the unbooked list holds it, and a
 * dry run refuses what the commit would, a booking outside the reversed
 * verifikat's fiscal year included.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from '@/lib/pos-sales/__tests__/fake-db'

const h = vi.hoisted(() => ({ findFiscalPeriod: vi.fn() }))

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  findFiscalPeriod: h.findFiscalPeriod,
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn(async () => ({ locked: false })) }))
vi.mock('@/lib/bookkeeping/account-validation', () => ({ findUnresolvableAccounts: vi.fn(async () => []) }))

import { webshopOrdersGet, webshopOrdersList } from '@/lib/operations/webshop-orders'
import { bookWebshopOrderWithLines } from '../service'

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never

let db: FakeDb

function order(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    company_id: COMPANY,
    platform: 'shopify',
    store_scope: 'butik.myshopify.com',
    store_label: 'Butiken',
    row_type: 'order',
    parent_order_id: null,
    order_number: `#${id}`,
    status: 'paid',
    is_paid: true,
    order_date: '2026-10-14',
    paid_date: '2026-10-14',
    currency: 'SEK',
    total: 125,
    total_tax: 25,
    total_sek: 125,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 100, tax: 25 }],
    line_items: [],
    customer_name: null,
    customer_company: null,
    customer_country: 'SE',
    payment_method: 'shopify_payments',
    payment_method_title: null,
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    manually_booked_at: null,
    manually_booked_journal_entry_id: null,
    remote_changed_after_freeze: false,
    ...overrides,
  }
}

const verifikat = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  source_type: 'webshop_order',
  status: 'reversed',
  voucher_series: 'L',
  fiscal_period_id: 'fp-2026',
  correction_of_id: null,
  ...overrides,
})

function ctx() {
  return { supabase: db.client as never, companyId: COMPANY, userId: 'user-1', log }
}

const LINES = [
  { account_number: '1686', debit_amount: 125, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 100 },
  { account_number: '2611', debit_amount: 0, credit_amount: 25 },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.findFiscalPeriod.mockResolvedValue('fp-2026')
  db = createFakeDb({
    webshop_orders: [
      order('released', { journal_entry_id: 'je-rev' }),
      order('booked', { journal_entry_id: 'je-posted' }),
      order('fresh'),
    ],
    journal_entries: [verifikat('je-rev'), verifikat('je-posted', { status: 'posted' })],
    webshop_store_settings: [],
    fiscal_periods: [],
  })
})

describe('gnubok_list_webshop_orders', () => {
  it('says to_book for an order its storno released, and booked for one whose verifikat stands', async () => {
    const outcome = await webshopOrdersList.run(ctx(), {}, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a list')
    expect(outcome.data.orders.map((o) => [o.webshop_order_id, o.booking_status, o.journal_entry_id])).toEqual([
      ['released', 'to_book', 'je-rev'],
      ['booked', 'booked', 'je-posted'],
      ['fresh', 'to_book', null],
    ])
  })

  it('lists the released order among the unbooked ones', async () => {
    const outcome = await webshopOrdersList.run(ctx(), { booked: 'unbooked' }, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected a list')
    expect(outcome.data.orders.map((o) => o.webshop_order_id)).toEqual(['released', 'fresh'])
    expect(outcome.data.orders.every((o) => o.booking_status === 'to_book')).toBe(true)
  })
})

describe('gnubok_get_webshop_order', () => {
  it('says to_book for an order its storno released', async () => {
    const outcome = await webshopOrdersGet.run(ctx(), { webshop_order_id: 'released' }, { dryRun: false })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected an order')
    expect(outcome.data).toMatchObject({ booking_status: 'to_book', journal_entry_id: 'je-rev' })
  })
})

describe('bookWebshopOrderWithLines, dry run', () => {
  it('previews booking a released order again in its reversed verifikat\'s fiscal year', async () => {
    const outcome = await bookWebshopOrderWithLines(ctx(), { webshop_order_id: 'released', lines: LINES }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { webshop_order_id: 'released' } })
    expect(db.updates).toEqual([])
  })

  it('refuses a released order dated in another fiscal year, as the commit would', async () => {
    h.findFiscalPeriod.mockResolvedValue('fp-2027')
    const outcome = await bookWebshopOrderWithLines(ctx(), { webshop_order_id: 'released', lines: LINES }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'WEBSHOP_ORDER_REBOOK_OTHER_SERIES_OR_YEAR',
      details: { journal_entry_id: 'je-rev', voucher_series: 'L', fiscal_period_id: 'fp-2026' },
    })
  })

  it('refuses an order whose verifikat stands', async () => {
    const outcome = await bookWebshopOrderWithLines(ctx(), { webshop_order_id: 'booked', lines: LINES }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_ORDER_ALREADY_BOOKED' })
  })
})
