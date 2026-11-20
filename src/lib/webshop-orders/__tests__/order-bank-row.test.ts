/**
 * The bank row a webshop order's booking links in the same approval
 * (crm#1993): checkOrderBankRow refuses, before anything is posted, a row
 * that is not this order's payment; linkOrderBankRow links through the
 * link door after posting and answers a refusal instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryLineInput, WebshopOrder } from '@/types'

const decideMock = vi.fn()
vi.mock('@/lib/transactions/is-booked', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transactions/is-booked')>('@/lib/transactions/is-booked')
  return { ...actual, decideBankRowRebooking: (...a: unknown[]) => decideMock(...a) }
})
const settlementMock = vi.fn()
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...a: unknown[]) => settlementMock(...a),
}))
const linkMock = vi.fn()
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  linkTransactionToJournalEntry: (...a: unknown[]) => linkMock(...a),
}))

import { checkOrderBankRow, linkOrderBankRow } from '../order-bank-row'

const log = createLogger('test')
const TX_ID = '11111111-1111-4111-8111-111111111111'
const JE_ID = '22222222-2222-4222-8222-222222222222'

function order(overrides: Partial<WebshopOrder> = {}): WebshopOrder {
  return {
    id: 'order-1',
    company_id: 'company-1',
    row_type: 'order',
    order_number: '20769',
    currency: 'SEK',
    total: 2798,
    total_tax: 559.6,
    total_sek: 2798,
    exchange_rate: 1,
    ...overrides,
  } as WebshopOrder
}

const SWISH_LINES: CreateJournalEntryLineInput[] = [
  { account_number: '1930', debit_amount: 2798, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 2238.4 },
  { account_number: '2611', debit_amount: 0, credit_amount: 559.6 },
]

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    date: '2026-11-17',
    amount: 2798,
    currency: 'SEK',
    description: 'Swish 20769',
    merchant_name: null,
    cash_account_id: 'ca-1930',
    journal_entry_id: null,
    reconciliation_method: null,
    is_ignored: false,
    transaction_voucher_links: [],
    ...overrides,
  }
}

async function check(
  tx: Record<string, unknown> | null,
  o: WebshopOrder = order(),
  lines: CreateJournalEntryLineInput[] = SWISH_LINES,
  error: unknown = null,
) {
  const { supabase, enqueue, calls } = createQueuedMockSupabase()
  enqueue({ data: tx, error })
  const result = await checkOrderBankRow(supabase as never, 'company-1', o, lines, TX_ID, log)
  return { result, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  decideMock.mockResolvedValue({ outcome: 'open' })
  settlementMock.mockResolvedValue('1930')
})

describe('checkOrderBankRow', () => {
  it('answers the row the approver sees for an unbooked row that is the order\'s payment', async () => {
    const { result, calls } = await check(row())
    expect(result).toEqual({
      ok: true,
      row: {
        transactionId: TX_ID,
        date: '2026-11-17',
        amount: 2798,
        currency: 'SEK',
        description: 'Swish 20769',
        accountNumber: '1930',
      },
    })
    // The company's row only.
    expect(calls).toContainEqual({ table: 'transactions', method: 'eq', args: ['company_id', 'company-1'] })
    expect(settlementMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'ca-1930', log, 'SEK')
  })

  it('takes a Stripe charge on 1686 for an order booked against 1686', async () => {
    settlementMock.mockResolvedValue('1686')
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1686', debit_amount: 1438, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1150.4 },
      { account_number: '2611', debit_amount: 0, credit_amount: 287.6 },
    ]
    const { result } = await check(row({ amount: 1438, cash_account_id: 'ca-1686' }), order({ total: 1438, total_sek: 1438 }), lines)
    expect(result).toMatchObject({ ok: true, row: { accountNumber: '1686', amount: 1438 } })
  })

  it('takes a refund paid out from the account (negative on both sides)', async () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '3001', debit_amount: 614.4, credit_amount: 0 },
      { account_number: '2611', debit_amount: 153.6, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 768 },
    ]
    const refund = order({ row_type: 'refund', total: -768, total_sek: -768 })
    const { result } = await check(row({ amount: -768 }), refund, lines)
    expect(result).toMatchObject({ ok: true, row: { amount: -768 } })
  })

  it('refuses a row outside the company', async () => {
    const { result } = await check(null)
    expect(result).toEqual({ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND', details: { transaction_id: TX_ID } })
  })

  it('refuses when the row cannot be read, so nothing is known about it', async () => {
    const { result } = await check(null, order(), SWISH_LINES, { message: 'timeout' })
    expect(result).toMatchObject({ ok: false, code: 'BANK_ROW_READ_FAILED' })
  })

  it('refuses a row a posted verifikat already books or links, naming it', async () => {
    decideMock.mockResolvedValue({
      outcome: 'refuse',
      via: 'pointer',
      journalEntryId: JE_ID,
      voucher: 'A12',
      replaceable: false,
      undo: 'uncategorize',
    })
    const { result } = await check(row({ journal_entry_id: JE_ID }))
    expect(result).toEqual({
      ok: false,
      code: 'LINK_TX_TX_ALREADY_LINKED',
      details: { transaction_id: TX_ID, journal_entry_id: JE_ID, voucher: 'A12', via: 'pointer' },
    })
    expect(decideMock).toHaveBeenCalledWith(expect.anything(), 'company-1', expect.objectContaining({ id: TX_ID }), { replace: false })
  })

  it('refuses an ignored row by the shared code', async () => {
    decideMock.mockResolvedValue({ outcome: 'refuse', via: 'ignored', journalEntryId: null, voucher: null, replaceable: false, undo: 'restore' })
    const { result } = await check(row({ is_ignored: true }))
    expect(result).toMatchObject({ ok: false, code: 'BANK_ROW_IGNORED' })
  })

  it('refuses a row whose amount is not the order total', async () => {
    const { result } = await check(row({ amount: 2799 }))
    expect(result).toMatchObject({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH',
      details: { transaction_amount: 2799, transaction_currency: 'SEK', order_total: 2798 },
    })
    expect(settlementMock).not.toHaveBeenCalled()
  })

  it('refuses an incoming row for a refund', async () => {
    const refund = order({ row_type: 'refund', total: -768, total_sek: -768 })
    const { result } = await check(row({ amount: 768 }), refund)
    expect(result).toMatchObject({ ok: false, code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH' })
  })

  it('compares a foreign order to a kronor row on its SEK total, and to a row in its own currency on its total', async () => {
    const eur = order({ currency: 'EUR', total: 100, total_sek: 1150 })
    const sekLines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1150, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1150 },
    ]
    expect((await check(row({ amount: 1150 }), eur, sekLines)).result).toMatchObject({ ok: true })
    expect((await check(row({ amount: 100 }), eur, sekLines)).result).toMatchObject({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH',
    })

    settlementMock.mockResolvedValue('1931')
    const eurLines: CreateJournalEntryLineInput[] = [
      { account_number: '1931', debit_amount: 1150, credit_amount: 0, currency: 'EUR', amount_in_currency: 100, exchange_rate: 11.5 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1150 },
    ]
    expect((await check(row({ amount: 100, currency: 'EUR' }), eur, eurLines)).result).toMatchObject({
      ok: true,
      row: { accountNumber: '1931', currency: 'EUR', amount: 100 },
    })
    // A row in a third currency is never the order's payment.
    expect((await check(row({ amount: 100, currency: 'USD' }), eur, eurLines)).result).toMatchObject({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_AMOUNT_MISMATCH',
    })
  })

  it('refuses lines that book the payment on another account than the row\'s', async () => {
    const onClearing: CreateJournalEntryLineInput[] = [{ ...SWISH_LINES[0], account_number: '1686' }, SWISH_LINES[1], SWISH_LINES[2]]
    const { result } = await check(row(), order(), onClearing)
    expect(result).toEqual({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_ACCOUNT_MISMATCH',
      details: { transaction_id: TX_ID, account_number: '1930', transaction_amount: 2798, lines_on_account: 0 },
    })
  })

  it('refuses lines that book another amount, or the other direction, on the row\'s account', async () => {
    const partly: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 2700, credit_amount: 0 },
      { account_number: '6570', debit_amount: 98, credit_amount: 0 },
      SWISH_LINES[1],
      SWISH_LINES[2],
    ]
    expect((await check(row(), order(), partly)).result).toMatchObject({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_ACCOUNT_MISMATCH',
      details: { lines_on_account: 2700 },
    })
    const reversed: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 0, credit_amount: 2798 },
      { account_number: '3001', debit_amount: 2798, credit_amount: 0 },
    ]
    expect((await check(row(), order(), reversed)).result).toMatchObject({
      ok: false,
      code: 'WEBSHOP_ORDER_TRANSACTION_ACCOUNT_MISMATCH',
    })
  })

  it('refuses a row whose bank account is in another currency than the row', async () => {
    settlementMock.mockRejectedValue(Object.assign(new Error('The transaction is in SEK but its bank account 1931 is in EUR'), { code: 'BANK_BOOKING_CURRENCY_MISMATCH' }))
    const { result } = await check(row())
    expect(result).toMatchObject({ ok: false, code: 'BANK_BOOKING_CURRENCY_MISMATCH' })
  })
})

describe('linkOrderBankRow', () => {
  it('links through the link door with the posted verifikat', async () => {
    linkMock.mockResolvedValue({ ok: true, result: { transactionId: TX_ID, journalEntryId: JE_ID } })
    const result = await linkOrderBankRow({} as never, 'company-1', 'user-1', TX_ID, JE_ID, log)
    expect(result).toEqual({ transactionId: TX_ID, linked: true })
    expect(linkMock).toHaveBeenCalledWith({}, 'user-1', 'company-1', { transactionId: TX_ID, journalEntryId: JE_ID })
  })

  it('answers the link door\'s refusal with its sentence, never throwing', async () => {
    linkMock.mockResolvedValue({ ok: false, code: 'BOOKING_REVIEW_REQUIRED', details: { transaction_id: TX_ID } })
    const result = await linkOrderBankRow({} as never, 'company-1', 'user-1', TX_ID, JE_ID, log)
    expect(result).toMatchObject({ transactionId: TX_ID, linked: false, code: 'BOOKING_REVIEW_REQUIRED', details: { transaction_id: TX_ID } })
    expect((result as { messageSv: string }).messageSv.length).toBeGreaterThan(0)
    expect((result as { messageEn: string }).messageEn.length).toBeGreaterThan(0)
  })

  it('answers a link that threw as a database failure', async () => {
    linkMock.mockRejectedValue(new Error('connection reset'))
    const result = await linkOrderBankRow({} as never, 'company-1', 'user-1', TX_ID, JE_ID, log)
    expect(result).toMatchObject({ linked: false, code: 'LINK_TX_DB_ERROR', details: { reason: 'connection reset' } })
  })
})
