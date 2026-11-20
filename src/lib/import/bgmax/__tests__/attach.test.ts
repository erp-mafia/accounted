import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCustomer, makeInvoice, makeTransaction } from '@/tests/helpers'
import { buildGiroRegister } from '@/lib/transactions/giro-counterparty'
import type { Transaction } from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseBgMax, type BgMaxDeposit } from '../parser'
import { attachBgMaxDeposits, matchDepositsToRows, type DepositRow } from '../attach'
import { OTHER_BG, OWN_BG, OWN_BG_DIGITS, septemberFile } from './bgmax-fixture'

const loadInvoiceMatchPool = vi.fn()
vi.mock('@/lib/invoices/invoice-matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/invoice-matching')>()),
  loadInvoiceMatchPool: (...args: unknown[]) => loadInvoiceMatchPool(...args),
}))

// ── Fixtures ────────────────────────────────────────────────────────────

const kundAb = makeCustomer({ id: 'cust-kund', name: 'Kund AB', org_number: '5560160680' })
const bolaget = makeCustomer({ id: 'cust-bolaget', name: 'Bolaget i Norr AB', org_number: '5591234567' })
const fjarde = makeCustomer({ id: 'cust-fjarde', name: 'Fjärde Kunden AB', org_number: null })

// OCR = the invoice number's digits plus a Luhn check digit (lib/invoices/ocr-keys.ts):
// 1001 -> 10017, 1002 -> 10025, 1003 -> 10033, 1004 -> 10041.
const invoice = (n: string, amount: number, customer: typeof kundAb) => ({
  ...makeInvoice({ id: `inv-${n}`, invoice_number: n, status: 'sent', total: amount, remaining_amount: amount, customer_id: customer.id }),
  customer,
})
const POOL = {
  invoices: [invoice('1001', 500, kundAb), invoice('1002', 1000, bolaget), invoice('1003', 250, kundAb), invoice('1004', 750, fjarde)],
}

const row = (overrides: Partial<Transaction>): DepositRow =>
  makeTransaction({
    merchant_name: null,
    potential_match_method: null,
    potential_journal_entry_id: null,
    ...overrides,
    // The bank's own text is what the matcher reads.
    original_description: overrides.original_description ?? overrides.description ?? null,
  }) as DepositRow

/** The bank rows the deposits are, as three banks print them, and rows that are not. */
const ROWS: DepositRow[] = [
  // SEB / Open Payments: the giro and the deposit serial number.
  row({ id: 'tx-seb', date: '2026-09-14', amount: 1500, description: `BG ${OWN_BG} 00012` }),
  // Swedbank PSD2: no text but the phrase; the bankgiro arrives as the reference.
  row({ id: 'tx-swedbank', date: '2026-09-15', amount: 200, description: 'Bankgiro inbetalning', reference: OWN_BG_DIGITS }),
  // Booked a day after Bankgirot's payment date, in words only.
  row({ id: 'tx-worded', date: '2026-09-17', amount: 750, description: 'BANKGIRO INBET' }),
  // Same date and amount as deposit 1, but not a bankgiro deposit / another bankgiro.
  row({ id: 'tx-swish', date: '2026-09-14', amount: 1500, description: 'Swish från Anna', merchant_name: 'Anna' }),
  row({ id: 'tx-other-bg', date: '2026-09-14', amount: 1500, description: `BG ${OTHER_BG} 00012` }),
]

const REGISTER = buildGiroRegister({ own: [{ bankgiro: OWN_BG_DIGITS }], suppliers: [] })

function deposits(): BgMaxDeposit[] {
  return parseBgMax(septemberFile()).deposits
}

function setup(rows: DepositRow[] = ROWS) {
  const mock = createTableMockSupabase({
    transactions: (chain) => (chain.some((c) => c.method === 'select') ? { data: rows } : { data: null }),
    company_settings: { data: { bankgiro: OWN_BG, plusgiro: null } },
    cash_accounts: { data: [] },
    suppliers: { data: [] },
  })
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  loadInvoiceMatchPool.mockResolvedValue(POOL)
})

// ── Which row is the deposit ────────────────────────────────────────────

describe('matchDepositsToRows', () => {
  it('finds each deposit\'s bank row by amount, bankgiro and date, and leaves a deposit with no row out', () => {
    const matches = matchDepositsToRows(deposits(), ROWS, REGISTER)
    expect(matches.map((m) => (m.status === 'matched' ? m.row.id : m.status))).toEqual([
      'tx-seb',
      'tx-swedbank',
      'tx-worded',
      'no_row',
    ])
  })

  it('never takes a row read as another bankgiro, or a row that does not say bankgiro', () => {
    const matches = matchDepositsToRows(deposits().slice(0, 1), ROWS.filter((r) => r.id !== 'tx-seb'), REGISTER)
    expect(matches).toEqual([{ status: 'no_row' }])
  })

  it('takes a row that says Autogiro: an Autogiro deposit comes through the same bankgiro', () => {
    const autogiro = row({ id: 'tx-autogiro', date: '2026-09-16', amount: 750, description: 'AUTOGIRO INSÄTTNING' })
    expect(matchDepositsToRows(deposits().slice(2, 3), [autogiro], REGISTER)).toEqual([{ status: 'matched', row: autogiro }])
  })

  it('takes no row further than three days from the payment date', () => {
    const late = row({ id: 'tx-late', date: '2026-09-20', amount: 750, description: 'BANKGIRO INBET' })
    expect(matchDepositsToRows(deposits().slice(2, 3), [late], REGISTER)).toEqual([{ status: 'no_row' }])
  })

  it('prefers the row that prints the deposit serial number over an equally dated one', () => {
    const bare = row({ id: 'tx-bare', date: '2026-09-14', amount: 1500, description: `BG ${OWN_BG}` })
    const matches = matchDepositsToRows(deposits().slice(0, 1), [bare, ROWS[0]!], REGISTER)
    expect(matches).toEqual([{ status: 'matched', row: ROWS[0] }])
  })

  it('leaves a deposit ambiguous when two rows fit it equally well', () => {
    const twinA = row({ id: 'tx-a', date: '2026-09-16', amount: 750, description: 'BANKGIRO INBET' })
    const twinB = row({ id: 'tx-b', date: '2026-09-16', amount: 750, description: 'BANKGIRO INBET' })
    expect(matchDepositsToRows(deposits().slice(2, 3), [twinA, twinB], REGISTER)).toEqual([
      { status: 'ambiguous', candidates: 2 },
    ])
  })

  it('pairs deposits that look the same with as many rows that look the same', () => {
    const same = deposits()[2]!
    const twins = [same, { ...same, payments: [{ ...same.payments[0]!, payer_name: 'Någon Annan AB' }] }]
    const rows = [
      row({ id: 'tx-b', date: '2026-09-16', amount: 750, description: 'BANKGIRO INBET' }),
      row({ id: 'tx-a', date: '2026-09-16', amount: 750, description: 'BANKGIRO INBET' }),
    ]
    const matches = matchDepositsToRows(twins, rows, REGISTER)
    expect(matches.map((m) => (m.status === 'matched' ? m.row.id : m.status))).toEqual(['tx-a', 'tx-b'])
  })

  it('lets the deposit that fits a row best claim it first', () => {
    // Two 750,00 deposits on the 16th and the 17th; only the 17th's row has synced.
    const sixteenth = deposits()[2]!
    const seventeenth = { ...sixteenth, date: '2026-09-17', serial: '00016' }
    const matches = matchDepositsToRows([sixteenth, seventeenth], [ROWS[2]!], REGISTER)
    expect(matches).toEqual([{ status: 'no_row' }, { status: 'matched', row: ROWS[2] }])
  })
})

// ── Attaching ───────────────────────────────────────────────────────────

describe('attachBgMaxDeposits', () => {
  it('previews without writing anything', async () => {
    const mock = setup()
    const summary = await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      deposits: deposits(),
      apply: false,
    })
    expect(summary).toMatchObject({
      applied: false,
      deposits: 4,
      payments: 6,
      matched_deposits: 3,
      matched_payments: 5,
      no_row: 1,
      ambiguous: 0,
    })
    expect(mock.tables()).not.toContain('bank_transaction_parts')
    expect(mock.findCalls('transactions', 'update')).toEqual([])
    expect(loadInvoiceMatchPool).not.toHaveBeenCalled()
  })

  it('stores each payment as a part of its bank row and proposes the invoice its OCR names', async () => {
    const mock = setup()
    const summary = await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      deposits: deposits(),
      apply: true,
    })

    const inserts = mock.payloads('bank_transaction_parts', 'insert') as Array<Array<Record<string, unknown>>>
    expect(inserts).toHaveLength(3)
    // Deposit 1: two payers, both resolved, summing to the row: one batch allocation.
    expect(inserts[0]).toEqual([
      expect.objectContaining({
        transaction_id: 'tx-seb', seq: 1, amount: 500, reference: '10017', counterparty_name: 'Kund AB',
        counterparty_org_number: '5560160680', provider_part_id: '000000000101',
        suggested_invoice_id: 'inv-1001', suggestion_reason: 'ocr_exact',
      }),
      expect.objectContaining({
        transaction_id: 'tx-seb', seq: 2, amount: 1000, reference: 'Faktura 1002', invoice_numbers: ['10025'],
        message: 'Tack för leveransen', suggested_invoice_id: 'inv-1002',
      }),
    ])
    // Deposit 2: the deduction is a negative part that pays no invoice.
    expect(inserts[1]).toEqual([
      expect.objectContaining({ transaction_id: 'tx-swedbank', amount: 250, suggested_invoice_id: 'inv-1003' }),
      expect.objectContaining({ transaction_id: 'tx-swedbank', amount: -50, suggested_invoice_id: null, suggestion_reason: null }),
    ])
    // Deposit 3: one payment for one invoice.
    expect(inserts[2]).toEqual([expect.objectContaining({ transaction_id: 'tx-worded', amount: 750, suggested_invoice_id: 'inv-1004' })])

    // The complete split marks its row; the single payment becomes the row's one-click match.
    expect(mock.payloads('transactions', 'update')).toEqual([
      { potential_match_method: 'bankgiro_split', potential_match_confidence: 0.95, potential_invoice_id: null, potential_supplier_invoice_id: null },
      { potential_invoice_id: 'inv-1004' },
    ])
    expect(mock.payloads('payment_match_log', 'insert')).toEqual([
      expect.objectContaining({ transaction_id: 'tx-seb', action: 'auto_suggested', match_method: 'bankgiro_split' }),
      expect.objectContaining({ transaction_id: 'tx-worded', action: 'auto_suggested', invoice_id: 'inv-1004', match_method: 'bgmax_ocr_exact' }),
    ])
    // Never a new bank row, never the row's own amount, date or text.
    expect(mock.findCalls('transactions', 'insert')).toEqual([])
    for (const update of mock.payloads('transactions', 'update') as Array<Record<string, unknown>>) {
      expect(Object.keys(update).every((k) => k.startsWith('potential_'))).toBe(true)
    }

    expect(summary).toMatchObject({
      applied: true,
      matched_deposits: 3,
      matched_payments: 5,
      suggested_payments: 4,
      ready_rows: 2,
      no_row: 1,
    })
    expect(summary.outcomes[3]).toMatchObject({ date: '2026-09-30', amount: 999, status: 'no_row', transaction_id: null })
  })

  it('a deposit with no bank row writes nothing and attaches once the row has synced', async () => {
    const lateRow = row({ id: 'tx-30th', date: '2026-09-30', amount: 999, description: `BG ${OWN_BG} 00015` })
    const before = setup()
    await attachBgMaxDeposits(before.supabase as unknown as SupabaseClient, {
      companyId: 'company-1', userId: 'user-1', deposits: deposits().slice(3), apply: true,
    })
    expect(before.tables()).not.toContain('bank_transaction_parts')

    const after = setup([...ROWS, lateRow])
    const summary = await attachBgMaxDeposits(after.supabase as unknown as SupabaseClient, {
      companyId: 'company-1', userId: 'user-1', deposits: deposits().slice(3), apply: true,
    })
    expect(summary.matched_deposits).toBe(1)
    expect(after.payloads('bank_transaction_parts', 'insert')).toEqual([
      [expect.objectContaining({ transaction_id: 'tx-30th', amount: 999, reference: null, suggested_invoice_id: null })],
    ])
  })

  it('is idempotent: the same file again writes the same split and no second hint', async () => {
    const first = setup()
    await attachBgMaxDeposits(first.supabase as unknown as SupabaseClient, {
      companyId: 'company-1', userId: 'user-1', deposits: deposits(), apply: true,
    })
    // The rows as the first upload left them.
    const afterFirst = ROWS.map((r) =>
      r.id === 'tx-seb'
        ? { ...r, potential_match_method: 'bankgiro_split' }
        : r.id === 'tx-worded'
          ? { ...r, potential_invoice_id: 'inv-1004' }
          : r,
    )
    const second = setup(afterFirst)
    const summary = await attachBgMaxDeposits(second.supabase as unknown as SupabaseClient, {
      companyId: 'company-1', userId: 'user-1', deposits: deposits(), apply: true,
    })

    expect(second.payloads('bank_transaction_parts', 'insert')).toEqual(first.payloads('bank_transaction_parts', 'insert'))
    // Each row's split replaces its previous one: a delete per row before the insert.
    expect(second.findCalls('bank_transaction_parts', 'delete')).toHaveLength(3)
    expect(second.payloads('transactions', 'update')).not.toContainEqual({ potential_invoice_id: 'inv-1004' })
    expect(summary.ready_rows).toBe(2)
  })

  it('stores the split of a booked row without proposing invoices', async () => {
    const booked = ROWS.map((r) => (r.id === 'tx-seb' ? { ...r, journal_entry_id: 'je-1' } : r))
    const mock = setup(booked)
    await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1', userId: 'user-1', deposits: deposits().slice(0, 1), apply: true,
    })
    expect(mock.payloads('bank_transaction_parts', 'insert')).toEqual([
      [
        expect.objectContaining({ seq: 1, suggested_invoice_id: null }),
        expect.objectContaining({ seq: 2, suggested_invoice_id: null }),
      ],
    ])
    expect(mock.findCalls('transactions', 'update')).toEqual([])
  })

  it('fails the call when the split write is refused', async () => {
    const mock = setup()
    mock.setTable('bank_transaction_parts', { error: { message: 'new row violates row-level security policy' } })
    await expect(
      attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
        companyId: 'company-1', userId: 'user-1', deposits: deposits().slice(0, 1), apply: true,
      }),
    ).rejects.toThrow(/bank_transaction_parts delete refused/)
  })
})
