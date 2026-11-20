/**
 * webshop-orders.book with transaction_id (crm#1993): the bank row that paid
 * the order is checked on the dry run and again before the approval posts,
 * shown in the staged preview, and linked to the verifikat after it is
 * posted. A link refused after posting leaves the booking standing and says
 * so in the answer. The row checks and the link door are pinned in
 * lib/webshop-orders/__tests__/order-bank-row.test.ts; these pin the wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeJournalEntry, type TableMockResult } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'

const createDraftEntryMock = vi.fn()
const commitEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    createDraftEntry: (...a: unknown[]) => createDraftEntryMock(...a),
    commitEntry: (...a: unknown[]) => commitEntryMock(...a),
  }
})
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({
  ensureWebshopPrefillAccounts: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/webshop-orders/order-underlag', () => ({
  archiveWebshopOrderUnderlag: vi.fn().mockResolvedValue({ ok: true, documentId: 'doc-1' }),
}))
const checkMock = vi.fn()
const linkMock = vi.fn()
vi.mock('@/lib/webshop-orders/order-bank-row', () => ({
  checkOrderBankRow: (...a: unknown[]) => checkMock(...a),
  linkOrderBankRow: (...a: unknown[]) => linkMock(...a),
}))

import { webshopOrdersBook } from '../webshop-orders'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TX_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const LINES = [
  { account_number: '1930', debit_amount: 2798, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 2238.4 },
  { account_number: '2611', debit_amount: 0, credit_amount: 559.6 },
]

const BANK_ROW = {
  transactionId: TX_ID,
  date: '2026-11-17',
  amount: 2798,
  currency: 'SEK',
  description: 'Swish 20769',
  accountNumber: '1930',
}

function order() {
  return {
    id: ORDER_ID,
    company_id: COMPANY_ID,
    platform: 'woocommerce',
    store_scope: 'butik.example',
    row_type: 'order',
    parent_order_id: null,
    order_number: '20769',
    status: 'completed',
    is_paid: true,
    order_date: '2026-11-17',
    paid_date: '2026-11-17',
    currency: 'SEK',
    total: 2798,
    total_tax: 559.6,
    total_sek: 2798,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 2238.4, tax: 559.6 }],
    line_items: [],
    customer_country: 'SE',
    payment_method: 'swish',
    payment_method_title: 'Swish',
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    remote_changed_after_freeze: false,
    manually_booked_at: null,
    manually_booked_journal_entry_id: null,
  }
}

function setup(webshopOrders: TableMockResult[]) {
  const { supabase, calls } = createTableMockSupabase({
    webshop_orders: webshopOrders,
    fiscal_periods: [{ data: [{ id: FP_ID }], error: null }, { data: { id: FP_ID, is_closed: false, locked_at: null }, error: null }],
    company_settings: { data: { bookkeeping_locked_through: null }, error: null },
    chart_of_accounts: {
      data: [{ account_number: '1930' }, { account_number: '3001' }, { account_number: '2611' }],
      error: null,
    },
    webshop_store_settings: { data: null, error: null },
  })
  const ctx = { supabase: supabase as never, companyId: COMPANY_ID, userId: 'user-1', log: createLogger('test') }
  return { ctx, calls }
}

const FOR_COMMIT: TableMockResult[] = [
  { data: order(), error: null },
  { data: order(), error: null },
  { data: [{ id: ORDER_ID }], error: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  createDraftEntryMock.mockResolvedValue(makeJournalEntry({ id: JE_ID, status: 'draft' }))
  commitEntryMock.mockResolvedValue(makeJournalEntry({ id: JE_ID, voucher_series: 'A', voucher_number: 214 }))
  checkMock.mockResolvedValue({ ok: true, row: BANK_ROW })
  linkMock.mockResolvedValue({ transactionId: TX_ID, linked: true })
})

describe('webshop-orders.book: transaction_id', () => {
  it('is optional and must be a UUID', () => {
    const base = { webshop_order_id: ORDER_ID, lines: LINES }
    expect(webshopOrdersBook.input.safeParse(base).success).toBe(true)
    const withRow = webshopOrdersBook.input.safeParse({ ...base, transaction_id: TX_ID })
    expect(withRow.success).toBe(true)
    expect(withRow.data?.transaction_id).toBe(TX_ID)
    expect(webshopOrdersBook.input.safeParse({ ...base, transaction_id: 'nope' }).success).toBe(false)
  })

  it('the dry run checks the row against the lines and shows it in the preview, writing nothing', async () => {
    const { ctx } = setup([{ data: order(), error: null }])
    const outcome = await webshopOrdersBook.run(ctx, { webshop_order_id: ORDER_ID, lines: LINES, transaction_id: TX_ID }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    const preview = (outcome as { preview: Record<string, unknown> }).preview
    expect(preview).toMatchObject({
      transaction_id: TX_ID,
      transaction_date: '2026-11-17',
      transaction_amount: 2798,
      transaction_currency: 'SEK',
      transaction_description: 'Swish 20769',
      bank_account: '1930',
    })
    expect(preview.will).toContain('link the bank transaction')
    expect(checkMock).toHaveBeenCalledWith(ctx.supabase, COMPANY_ID, expect.objectContaining({ id: ORDER_ID }), LINES, TX_ID, ctx.log)
    expect(createDraftEntryMock).not.toHaveBeenCalled()
    expect(linkMock).not.toHaveBeenCalled()
  })

  it('the dry run answers the row\'s refusal, so nothing is staged', async () => {
    checkMock.mockResolvedValue({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH',
      details: { transaction_id: TX_ID, transaction_amount: 2799 },
    })
    const { ctx } = setup([{ data: order(), error: null }])
    const outcome = await webshopOrdersBook.run(ctx, { webshop_order_id: ORDER_ID, lines: LINES, transaction_id: TX_ID }, { dryRun: true })
    expect(outcome).toEqual({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH',
      details: { transaction_id: TX_ID, transaction_amount: 2799 },
    })
  })

  it('the approval books the order, then links the row to the posted verifikat', async () => {
    const { ctx } = setup(FOR_COMMIT)
    const outcome = await webshopOrdersBook.run(ctx, { webshop_order_id: ORDER_ID, lines: LINES, transaction_id: TX_ID }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      created: true,
      data: {
        webshop_order_id: ORDER_ID,
        journal_entry_id: JE_ID,
        transaction_link: { transaction_id: TX_ID, linked: true, refusal: null },
      },
    })
    expect((outcome as { warnings?: unknown }).warnings).toBeUndefined()
    expect(linkMock).toHaveBeenCalledWith(ctx.supabase, COMPANY_ID, 'user-1', TX_ID, JE_ID, ctx.log)
    // Checked before the draft, linked after the commit.
    expect(checkMock.mock.invocationCallOrder[0]).toBeLessThan(createDraftEntryMock.mock.invocationCallOrder[0])
    expect(commitEntryMock.mock.invocationCallOrder[0]).toBeLessThan(linkMock.mock.invocationCallOrder[0])
  })

  it('a link refused after posting leaves the booking standing and says why, with no storno', async () => {
    linkMock.mockResolvedValue({
      transactionId: TX_ID,
      linked: false,
      code: 'BOOKING_REVIEW_REQUIRED',
      messageSv: 'En granskningsregel kräver att en person bokför transaktionen.',
      messageEn: 'A review rule requires a person to book the transaction.',
    })
    const { ctx, calls } = setup(FOR_COMMIT)
    const outcome = await webshopOrdersBook.run(ctx, { webshop_order_id: ORDER_ID, lines: LINES, transaction_id: TX_ID }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      created: true,
      data: {
        journal_entry_id: JE_ID,
        voucher_number: 214,
        transaction_link: {
          transaction_id: TX_ID,
          linked: false,
          refusal: {
            code: 'BOOKING_REVIEW_REQUIRED',
            message_sv: 'En granskningsregel kräver att en person bokför transaktionen.',
            message_en: 'A review rule requires a person to book the transaction.',
          },
        },
      },
    })
    const warnings = (outcome as { warnings?: Array<{ code: string; message_sv: string }> }).warnings ?? []
    expect(warnings.map((w) => w.code)).toEqual(['WEBSHOP_ORDER_TRANSACTION_NOT_LINKED'])
    expect(warnings[0].message_sv).toContain('En granskningsregel kräver att en person bokför transaktionen.')
    // The verifikat is neither cancelled nor reversed.
    expect(calls.some((c) => c.table === 'journal_entries' && c.method === 'update')).toBe(false)
    expect(calls.some((c) => c.method === 'rpc')).toBe(false)
  })

  it('refuses at the approval, before anything is posted, when the row stopped being the order\'s payment', async () => {
    checkMock.mockResolvedValue({ ok: false, code: 'LINK_TX_TX_ALREADY_LINKED', details: { transaction_id: TX_ID, journal_entry_id: JE_ID } })
    const { ctx } = setup(FOR_COMMIT)
    const outcome = await webshopOrdersBook.run(ctx, { webshop_order_id: ORDER_ID, lines: LINES, transaction_id: TX_ID }, { dryRun: false })
    expect(outcome).toEqual({ ok: false, code: 'LINK_TX_TX_ALREADY_LINKED', details: { transaction_id: TX_ID, journal_entry_id: JE_ID } })
    expect(createDraftEntryMock).not.toHaveBeenCalled()
    expect(linkMock).not.toHaveBeenCalled()
  })

  it('without transaction_id books as before: no row read, no link, no transaction_link', async () => {
    const { ctx } = setup(FOR_COMMIT)
    const outcome = await webshopOrdersBook.run(ctx, { webshop_order_id: ORDER_ID, lines: LINES }, { dryRun: false })
    expect(outcome.ok).toBe(true)
    expect((outcome as unknown as { data: Record<string, unknown> }).data.transaction_link).toBeUndefined()
    expect(checkMock).not.toHaveBeenCalled()
    expect(linkMock).not.toHaveBeenCalled()
  })
})
