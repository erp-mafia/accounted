/**
 * The bank's notification (camt.054) through the deposit attachment
 * (lib/import/bgmax/attach.ts): which bank row an entry is, with the account
 * the notification names as evidence, and what is written. The attachment's
 * own rules (the date window, ties, idempotence) are tested with BG Max in
 * lib/import/bgmax/__tests__/attach.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCustomer, makeInvoice, makeTransaction } from '@/tests/helpers'
import { buildGiroRegister } from '@/lib/transactions/giro-counterparty'
import { attachBgMaxDeposits, matchDepositsToRows, type DepositRow } from '@/lib/import/bgmax/attach'
import { OTHER_BG, OWN_BG, OWN_BG_DIGITS } from '@/lib/import/bgmax/__tests__/bgmax-fixture'
import type { Transaction } from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseCamt054, type Camt054Deposit } from '../parser'
import { OWN_IBAN, decemberFile, document, entry, notification, payment } from './camt054-fixture'

const loadInvoiceMatchPool = vi.fn()
vi.mock('@/lib/invoices/invoice-matching', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/invoice-matching')>()),
  loadInvoiceMatchPool: (...args: unknown[]) => loadInvoiceMatchPool(...args),
}))

// ── Fixtures ────────────────────────────────────────────────────────────

const kundAb = makeCustomer({ id: 'cust-kund', name: 'Kund AB', org_number: '5560160680' })
const bolaget = makeCustomer({ id: 'cust-bolaget', name: 'Bolaget i Norr AB', org_number: '5591234567' })
const fjarde = makeCustomer({ id: 'cust-fjarde', name: 'Fjärde Kunden AB', org_number: null })

// OCR = the invoice number's digits plus a Luhn check digit: 1001 -> 10017.
const invoice = (n: string, amount: number, customer: typeof kundAb) => ({
  ...makeInvoice({ id: `inv-${n}`, invoice_number: n, status: 'sent', total: amount, remaining_amount: amount, customer_id: customer.id }),
  customer,
})
const POOL = { invoices: [invoice('1001', 500, kundAb), invoice('1004', 750, fjarde), invoice('1005', 250, bolaget)] }

const OWN_ACCOUNT = 'ca-own'
const OTHER_ACCOUNT = 'ca-other'
/** The company's cash accounts: the notification's account and another one. */
const CASH_ACCOUNTS = [
  { id: OWN_ACCOUNT, ledger_account: '1930', iban: OWN_IBAN, bban: null, clearing_number: null, account_number: null, currency: 'SEK', enabled: true, is_primary: true, bank_connection_id: 'conn-1', bankgiro: null, plusgiro: null },
  { id: OTHER_ACCOUNT, ledger_account: '1940', iban: 'SE3550000000054910000003', bban: null, clearing_number: null, account_number: null, currency: 'SEK', enabled: true, is_primary: false, bank_connection_id: 'conn-1', bankgiro: null, plusgiro: null },
]

const row = (overrides: Partial<Transaction>): DepositRow =>
  makeTransaction({
    merchant_name: null,
    potential_match_method: null,
    potential_journal_entry_id: null,
    cash_account_id: OWN_ACCOUNT,
    ...overrides,
    original_description: overrides.original_description ?? overrides.description ?? null,
  }) as DepositRow

const REGISTER = buildGiroRegister({ own: [{ bankgiro: OWN_BG_DIGITS }], suppliers: [] })
const ON_OWN_ACCOUNT = [new Set([OWN_ACCOUNT])]

/** The 1 500,00 entry of 1 December with its three payments. */
function december(): Camt054Deposit {
  return parseCamt054(decemberFile()).deposits[0]!
}

/** One entry of `amount` with a single payment and no receiving bankgiro. */
function bare(amount: string, date: string, valueDate?: string, payer: { name: string; ocr: string } = { name: 'Kund AB', ocr: '10017' }): Camt054Deposit {
  return parseCamt054(
    document([
      notification({
        entries: [entry({ amount, date, valueDate, payments: [payment({ amount, receiverBankgiro: null, payerName: payer.name, structured: [{ ocr: payer.ocr }] })] })],
      }),
    ]),
  ).deposits[0]!
}

const ALFA = { name: 'Alfa Bygg AB', ocr: '10017' }
const BETA = { name: 'Beta Måleri AB', ocr: '20025' }

const ids = (matches: ReturnType<typeof matchDepositsToRows>) => matches.map((m) => (m.status === 'matched' ? m.row.id : m.status))

function setup(rows: DepositRow[]) {
  return createTableMockSupabase({
    transactions: (chain) => (chain.some((c) => c.method === 'select') ? { data: rows } : { data: null }),
    company_settings: { data: { bankgiro: OWN_BG, plusgiro: null } },
    cash_accounts: { data: CASH_ACCOUNTS },
    suppliers: { data: [] },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  loadInvoiceMatchPool.mockResolvedValue(POOL)
})

// ── Which row is the entry ──────────────────────────────────────────────

describe('matchDepositsToRows with an entry of the bank\'s notification', () => {
  it('takes the row on the notification\'s account booked that day, whatever its text says', () => {
    const plain = row({ id: 'tx-plain', date: '2026-12-01', amount: 500, description: 'Insättning' })
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [plain], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-plain'])
    // Without an account to go by, such a row is not evidence enough.
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [plain], REGISTER))).toEqual(['no_row'])
  })

  it('takes such a row on the value date too, but on no other day', () => {
    const nextDay = row({ id: 'tx-next', date: '2026-12-02', amount: 500, description: 'Insättning' })
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [nextDay], REGISTER, ON_OWN_ACCOUNT))).toEqual(['no_row'])
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01', '2026-12-02')], [nextDay], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-next'])
  })

  it('never takes a row on another account, even one that says bankgiro', () => {
    const elsewhere = row({ id: 'tx-elsewhere', date: '2026-12-01', amount: 1500, description: 'BANKGIRO INBET', cash_account_id: OTHER_ACCOUNT })
    expect(ids(matchDepositsToRows([december()], [elsewhere], REGISTER, ON_OWN_ACCOUNT))).toEqual(['no_row'])
    // The same row is the deposit when the source names no account.
    expect(ids(matchDepositsToRows([december()], [elsewhere], REGISTER))).toEqual(['tx-elsewhere'])
  })

  it('reads a row with no account by its bankgiro wording, on the entry\'s day', () => {
    const unbound = row({ id: 'tx-unbound', date: '2026-12-01', amount: 1500, description: 'BANKGIRO INBET', cash_account_id: null })
    expect(ids(matchDepositsToRows([december()], [unbound], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-unbound'])
  })

  it('reads a row through one of the company\'s bankgiros when the notification names none, and never another giro\'s row', () => {
    const own = row({ id: 'tx-own', date: '2026-12-01', amount: 500, description: `BG ${OWN_BG} 00012` })
    const other = row({ id: 'tx-other', date: '2026-12-01', amount: 1500, description: `BG ${OTHER_BG} 00012` })
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [own], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-own'])
    expect(ids(matchDepositsToRows([december()], [other], REGISTER, ON_OWN_ACCOUNT))).toEqual(['no_row'])
  })

  it('takes no row on another day than the entry\'s booking or value date, whatever the row says', () => {
    // The entry's own row has not synced; a bankgiro deposit of the same amount sits two days later.
    const nearby = row({ id: 'tx-nearby', date: '2026-12-03', amount: 500, description: `BG ${OWN_BG} 00014` })
    const worded = row({ id: 'tx-worded', date: '2026-12-02', amount: 1500, description: 'BANKGIRO INBET' })
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [nearby], REGISTER, ON_OWN_ACCOUNT))).toEqual(['no_row'])
    expect(ids(matchDepositsToRows([december()], [worded], REGISTER, ON_OWN_ACCOUNT))).toEqual(['no_row'])
    // A value date far from the booking date is still the entry's day.
    const farValue = row({ id: 'tx-far', date: '2026-12-08', amount: 500, description: 'Insättning' })
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01', '2026-12-08')], [farValue], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-far'])
  })

  it('gives each of two entries with different value dates its own row, in either order', () => {
    const first = bare('500.00', '2026-12-01', '2026-12-01')
    const second = bare('500.00', '2026-12-01', '2026-12-02')
    const rows = [
      row({ id: 'tx-first', date: '2026-12-01', amount: 500, description: 'Insättning' }),
      row({ id: 'tx-second', date: '2026-12-02', amount: 500, description: 'Insättning' }),
    ]
    const both = [new Set([OWN_ACCOUNT]), new Set([OWN_ACCOUNT])]
    expect(ids(matchDepositsToRows([first, second], rows, REGISTER, both))).toEqual(['tx-first', 'tx-second'])
    expect(ids(matchDepositsToRows([second, first], rows, REGISTER, both))).toEqual(['tx-second', 'tx-first'])
  })

  it('prefers the row that says bankgiro over one that only sits on the account', () => {
    const plain = row({ id: 'tx-plain', date: '2026-12-01', amount: 1500, description: 'Insättning' })
    const worded = row({ id: 'tx-worded', date: '2026-12-01', amount: 1500, description: 'Bankgiro inbetalning' })
    expect(ids(matchDepositsToRows([december()], [plain, worded], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-worded'])
  })

  it('leaves an entry ambiguous when two rows on the account fit it equally well', () => {
    const a = row({ id: 'tx-a', date: '2026-12-01', amount: 500, description: 'Insättning' })
    const b = row({ id: 'tx-b', date: '2026-12-01', amount: 500, description: 'Insättning' })
    expect(matchDepositsToRows([bare('500.00', '2026-12-01')], [a, b], REGISTER, ON_OWN_ACCOUNT)).toEqual([{ status: 'ambiguous', candidates: 2 }])
  })

  it('takes the row that carries the entry\'s reference when two rows fit equally well', () => {
    const blank = row({ id: 'tx-blank', date: '2026-12-01', amount: 500, description: 'Insättning' })
    const referenced = row({ id: 'tx-ref', date: '2026-12-01', amount: 500, description: 'Insättning', reference: '10017' })
    const inText = row({ id: 'tx-text', date: '2026-12-01', amount: 500, description: 'Insättning ref 10017' })
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [blank, referenced], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-ref'])
    expect(ids(matchDepositsToRows([bare('500.00', '2026-12-01')], [blank, inText], REGISTER, ON_OWN_ACCOUNT))).toEqual(['tx-text'])
  })

  const TWO = [new Set([OWN_ACCOUNT]), new Set([OWN_ACCOUNT])]

  it('pairs entries of the same day and amount with the rows that name their payers or carry their references', () => {
    const entries = [bare('500.00', '2026-12-01', undefined, ALFA), bare('500.00', '2026-12-01', undefined, BETA)]
    const named = [
      row({ id: 'tx-beta', date: '2026-12-01', amount: 500, description: 'Insättning Beta Måleri AB' }),
      row({ id: 'tx-alfa', date: '2026-12-01', amount: 500, description: 'Insättning', merchant_name: 'ALFA BYGG AB' }),
    ]
    expect(ids(matchDepositsToRows(entries, named, REGISTER, TWO))).toEqual(['tx-alfa', 'tx-beta'])
    expect(ids(matchDepositsToRows([...entries].reverse(), named, REGISTER, TWO))).toEqual(['tx-beta', 'tx-alfa'])

    const referenced = [
      row({ id: 'tx-20025', date: '2026-12-01', amount: 500, description: 'Insättning', reference: '20025' }),
      row({ id: 'tx-10017', date: '2026-12-01', amount: 500, description: 'Insättning', reference: '10017' }),
    ]
    expect(ids(matchDepositsToRows(entries, referenced, REGISTER, TWO))).toEqual(['tx-10017', 'tx-20025'])
  })

  it('leaves such entries ambiguous when the rows differ and say nothing that tells which is which', () => {
    const entries = [bare('500.00', '2026-12-01', undefined, ALFA), bare('500.00', '2026-12-01', undefined, BETA)]
    const rows = [
      row({ id: 'tx-x', date: '2026-12-01', amount: 500, description: 'Insättning 1' }),
      row({ id: 'tx-y', date: '2026-12-01', amount: 500, description: 'Insättning 2' }),
    ]
    expect(matchDepositsToRows(entries, rows, REGISTER, TWO)).toEqual([
      { status: 'ambiguous', candidates: 2 },
      { status: 'ambiguous', candidates: 2 },
    ])
    // One of them names its payer: that entry is settled, and the other takes the row that is left.
    const oneNamed = [rows[0]!, row({ id: 'tx-beta', date: '2026-12-01', amount: 500, description: 'Insättning Beta Måleri AB' })]
    expect(ids(matchDepositsToRows(entries, oneNamed, REGISTER, TWO))).toEqual(['tx-x', 'tx-beta'])
  })

  it('pairs entries that look the same with as many rows that say the same thing, in order', () => {
    const a = row({ id: 'tx-a', date: '2026-12-01', amount: 500, description: 'Insättning' })
    const b = row({ id: 'tx-b', date: '2026-12-01', amount: 500, description: 'Insättning' })
    const twins = [bare('500.00', '2026-12-01', undefined, ALFA), bare('500.00', '2026-12-01', undefined, BETA)]
    expect(ids(matchDepositsToRows(twins, [b, a], REGISTER, TWO))).toEqual(['tx-a', 'tx-b'])
  })
})

// ── Attaching ───────────────────────────────────────────────────────────

describe('attachBgMaxDeposits with the bank\'s notification', () => {
  it('finds the row through the notification\'s account and stores each payment as a part', async () => {
    const plain = row({ id: 'tx-plain', date: '2026-12-01', amount: 1500, description: 'Insättning' })
    const elsewhere = row({ id: 'tx-elsewhere', date: '2026-12-01', amount: 1500, description: 'Insättning', cash_account_id: OTHER_ACCOUNT })
    const mock = setup([elsewhere, plain])
    const summary = await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      deposits: [december()],
      apply: true,
      source: 'camt054',
    })

    expect(mock.payloads('bank_transaction_parts', 'insert')).toEqual([
      [
        expect.objectContaining({
          transaction_id: 'tx-plain', seq: 1, amount: 500, reference: '10017', counterparty_name: 'Kund AB',
          provider_part_id: '492950108394', suggested_invoice_id: 'inv-1001', suggestion_reason: 'ocr_exact',
        }),
        expect.objectContaining({
          transaction_id: 'tx-plain', seq: 2, amount: 750, reference: '1004', message: 'Faktura 1004', suggested_invoice_id: 'inv-1004',
        }),
        expect.objectContaining({
          transaction_id: 'tx-plain', seq: 3, amount: 250, reference: null, counterparty_org_number: '5591234567', suggested_invoice_id: 'inv-1005',
        }),
      ],
    ])
    // Every payment resolved and they sum to the row: one batch allocation.
    expect(mock.payloads('transactions', 'update')).toEqual([
      { potential_match_method: 'bankgiro_split', potential_match_confidence: 0.95, potential_invoice_id: null, potential_supplier_invoice_id: null },
    ])
    expect(mock.findCalls('transactions', 'insert')).toEqual([])
    expect(summary).toMatchObject({ applied: true, deposits: 1, payments: 3, matched_deposits: 1, suggested_payments: 3, ready_rows: 1, no_row: 0 })
    expect(summary.outcomes[0]).toMatchObject({ bankgiro: OWN_BG, status: 'matched', transaction_id: 'tx-plain' })
  })

  it('gives a single payment its row\'s one-click match and logs where it came from', async () => {
    const plain = row({ id: 'tx-plain', date: '2026-12-01', amount: 500, description: 'Insättning' })
    const mock = setup([plain])
    const summary = await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      deposits: [bare('500.00', '2026-12-01')],
      apply: true,
      source: 'camt054',
    })
    expect(mock.payloads('transactions', 'update')).toEqual([{ potential_invoice_id: 'inv-1001' }])
    expect(mock.payloads('payment_match_log', 'insert')).toEqual([
      expect.objectContaining({ transaction_id: 'tx-plain', action: 'auto_suggested', invoice_id: 'inv-1001', match_method: 'camt054_ocr_exact' }),
    ])
    expect(summary).toMatchObject({ ready_rows: 1 })
    expect(summary.outcomes[0]).toMatchObject({ bankgiro: null, status: 'matched' })
  })

  it('reads the bank rows of the value date too', async () => {
    const mock = setup([])
    await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      deposits: [bare('500.00', '2026-12-01', '2026-12-10')],
      apply: false,
      source: 'camt054',
    })
    expect(mock.findCalls('transactions', 'gte')).toEqual([['date', '2026-11-28']])
    expect(mock.findCalls('transactions', 'lte')).toEqual([['date', '2026-12-13']])
  })

  it('previews without writing, and reports an entry whose row has not synced', async () => {
    const mock = setup([])
    const summary = await attachBgMaxDeposits(mock.supabase as unknown as SupabaseClient, {
      companyId: 'company-1',
      userId: 'user-1',
      deposits: [december()],
      apply: false,
      source: 'camt054',
    })
    expect(summary).toMatchObject({ applied: false, matched_deposits: 0, no_row: 1 })
    expect(mock.tables()).not.toContain('bank_transaction_parts')
    expect(loadInvoiceMatchPool).not.toHaveBeenCalled()
  })
})
