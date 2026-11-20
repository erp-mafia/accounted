import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AR_CREDIT_SIDE,
  BANK_DEBIT_SIDE,
  invoiceSettlementSideFor,
  resolveInvoiceSettlementSide,
  settlesOnAccount,
  voucherBooksSale,
  vouchersBookingSale,
} from '../invoice-settlement-side'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('invoiceSettlementSideFor (the TypeScript twin of invoice_settlement_side)', () => {
  it.each([
    ['cash', null, BANK_DEBIT_SIDE],
    ['cash', undefined, BANK_DEBIT_SIDE],
    // A kontantmetod invoice carried over the year end, or booked at issue
    // before a method switch: its receivable sits on 1510 (#3440).
    ['cash', 'je-carry', AR_CREDIT_SIDE],
    ['accrual', null, AR_CREDIT_SIDE],
    ['accrual', 'je-reg', AR_CREDIT_SIDE],
    // No settings row: faktureringsmetoden, as the SQL COALESCE.
    [null, null, AR_CREDIT_SIDE],
    [undefined, null, AR_CREDIT_SIDE],
  ] as const)('method %s, journal_entry_id %s', (method, link, expected) => {
    expect(invoiceSettlementSideFor(method, link)).toEqual(expected)
  })
})

describe('settlesOnAccount (the TypeScript twin of invoice_settlement_line)', () => {
  it.each([
    // Unbooked kontantmetod invoice: where the money landed, the firm's
    // liquid funds or the owner's private funds (crm#1580).
    [BANK_DEBIT_SIDE, '1930', true],
    [BANK_DEBIT_SIDE, '1910', true],
    [BANK_DEBIT_SIDE, '2013', true],
    [BANK_DEBIT_SIDE, '2018', false],
    [BANK_DEBIT_SIDE, '1510', false],
    [BANK_DEBIT_SIDE, '2440', false],
    [BANK_DEBIT_SIDE, null, false],
    // Booked invoice: the receivable only.
    [AR_CREDIT_SIDE, '1510', true],
    [AR_CREDIT_SIDE, '1513', true],
    [AR_CREDIT_SIDE, '2013', false],
    [AR_CREDIT_SIDE, '1930', false],
  ] as const)('%o on %s settles: %s', (side, account, expected) => {
    expect(settlesOnAccount(side, account)).toBe(expected)
  })
})

type Line = [account: string, debit: number, credit: number]
const lines = (rows: Line[]) =>
  rows.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))

describe('voucherBooksSale (the TypeScript twin of invoice_voucher_books_sale)', () => {
  // The shapes production links on the bank_debit side (#146 review) and the
  // two the issue is about. The SQL twin runs the same table in
  // tests/pg/invoice-voucher-books-sale-parity.pg.test.ts.
  it.each([
    ['the sale booked at payment', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], [], true],
    ['the sale the customer paid the owner privately', [['2013', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]], [], true],
    ['a receivable booked elsewhere (a migrated carry)', [['1930', 1250, 0], ['1510', 0, 1250]], [], true],
    ['an outlay the invoice line posts to 1680', [['1930', 1000, 0], ['3740', 0.4, 0], ['1680', 0, 1000.4]], ['1680'], true],
    ['the same outlay when no line posts to 1680', [['1930', 1000, 0], ['3740', 0.4, 0], ['1680', 0, 1000.4]], [], false],
    ['interest on an invoice line\'s 8xxx account', [['1930', 500, 0], ['8313', 0, 500]], ['8313'], true],
    ['a private withdrawal', [['2013', 1250, 0], ['1930', 0, 1250]], [], false],
    ['an owner deposit', [['1930', 1250, 0], ['2018', 0, 1250]], [], false],
    ['a sale next to a withdrawal from the bank', [['2013', 1750, 0], ['3001', 0, 1000], ['2611', 0, 250], ['1930', 0, 500]], [], false],
    ['a 3xxx debit only (no sale credited)', [['1930', 100, 0], ['3740', 0, 0], ['2018', 0, 100]], [], false],
  ] as const)('%s: %s', (_label, rows, lineAccounts, expected) => {
    expect(voucherBooksSale(lines(rows as unknown as Line[]), lineAccounts)).toBe(expected)
  })

  it('reads account numbers as strings, by prefix', () => {
    expect(voucherBooksSale([{ account_number: null, debit_amount: 0, credit_amount: 100 }], [])).toBe(false)
    expect(voucherBooksSale([{ account_number: '1930', debit_amount: 0, credit_amount: '100' }], [])).toBe(false)
    expect(voucherBooksSale([{ account_number: '1519', debit_amount: 0, credit_amount: '100' }], [])).toBe(true)
  })
})

describe('vouchersBookingSale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the vouchers that book the sale and reads no invoice lines when all do', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'l1', journal_entry_id: 'je-sale', account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { id: 'l2', journal_entry_id: 'je-sale', account_number: '3001', debit_amount: 0, credit_amount: 1250 },
        { id: 'l3', journal_entry_id: 'je-carry', account_number: '1930', debit_amount: 1250, credit_amount: 0 },
        { id: 'l4', journal_entry_id: 'je-carry', account_number: '1510', debit_amount: 0, credit_amount: 1250 },
      ],
    })

    const sales = await vouchersBookingSale(supabase as never, 'inv-1', ['je-sale', 'je-carry'])

    expect([...sales].sort()).toEqual(['je-carry', 'je-sale'])
    expect(findCalls('invoice_items', 'select')).toEqual([])
  })

  it('reads the invoice\'s line accounts only for a voucher that needs them', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'l1', journal_entry_id: 'je-outlay', account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { id: 'l2', journal_entry_id: 'je-outlay', account_number: '1680', debit_amount: 0, credit_amount: 1000 },
        { id: 'l3', journal_entry_id: 'je-deposit', account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { id: 'l4', journal_entry_id: 'je-deposit', account_number: '2018', debit_amount: 0, credit_amount: 1000 },
      ],
    })
    enqueue({ data: [{ id: 'it-1', revenue_account: '1680' }, { id: 'it-2', revenue_account: null }] })

    const sales = await vouchersBookingSale(supabase as never, 'inv-1', ['je-outlay', 'je-deposit'])

    expect([...sales]).toEqual(['je-outlay'])
  })

  it('reads every voucher in chunks, so a wide window drops none', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const ids = Array.from({ length: 150 }, (_, i) => `je-${i}`)
    for (const chunkIds of [ids.slice(0, 100), ids.slice(100)]) {
      enqueue({
        data: chunkIds.flatMap((id) => [
          { id: `${id}-a`, journal_entry_id: id, account_number: '1930', debit_amount: 10, credit_amount: 0 },
          { id: `${id}-b`, journal_entry_id: id, account_number: '3001', debit_amount: 0, credit_amount: 10 },
        ]),
      })
    }

    const sales = await vouchersBookingSale(supabase as never, 'inv-1', ids)

    expect(sales.size).toBe(150)
    expect(findCalls('journal_entry_lines', 'in').map((args) => (args[1] as string[]).length)).toEqual([100, 50])
  })

  it('throws when the lines cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(vouchersBookingSale(supabase as never, 'inv-1', ['je-1'])).rejects.toThrow('boom')
  })
})

describe('resolveInvoiceSettlementSide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the database function, by invoice id, and returns what it says', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { settlement_side: 'bank_debit', account_prefix: '19', entry_side: 'debit' } })

    const side = await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1')

    expect(side).toEqual(BANK_DEBIT_SIDE)
    expect(supabase.rpc).toHaveBeenCalledWith('invoice_settlement_side', {
      p_invoice_id: 'inv-1',
      p_company_id: 'company-1',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reads the 151x credit for a carried kontantmetod invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' } })
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(AR_CREDIT_SIDE)
  })

  // A deploy that reaches the app before the migration, or a transient read
  // failure: the twin decides from the same two facts, read directly.
  it.each([
    ['the call fails', { data: null, error: { message: 'function does not exist' } }],
    ['the invoice is not visible (no row)', { data: null }],
    ['the answer is not one of the two sides', { data: { settlement_side: 'x' } }],
  ])('falls back to the twin when %s', async (_label, response) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(response)
    enqueue({ data: { accounting_method: 'cash' } }) // company_settings
    enqueue({ data: { id: 'inv-1', journal_entry_id: null } }) // invoices
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(BANK_DEBIT_SIDE)
  })

  it('keeps a carried invoice on 151x in the fallback too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: { accounting_method: 'cash' } })
    enqueue({ data: { id: 'inv-1', journal_entry_id: 'je-carry' } })
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(AR_CREDIT_SIDE)
  })

  it('answers the 151x credit when even the fallback read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: null, error: { message: 'settings read failed' } })
    enqueue({ data: null })
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(AR_CREDIT_SIDE)
  })
})
