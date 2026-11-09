/**
 * crm#1501: what bulk_book_transactions refuses at commit is refused by the
 * dry run that staging runs.
 *
 * An agent staged a transfer between the company's own cash accounts (one
 * row out of 1930, lines D 1931 / K 1930); the dry run and the staging said
 * OK, the approval failed with BULK_BOOK_AMOUNT_MISMATCH: the RPC counts
 * every 1900-1999 line into the bank net, so the transfer's other end
 * cancels the row. The dry run now asks the same bank net (bankNetMismatch)
 * and refuses before staging, naming the doors that book a transfer:
 * categorize the row with the other account, link the other row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { bankNetMismatch, bulkBookTransactions, type BulkBookInput } from '../bulk-book'

const covered = vi.hoisted(() => vi.fn())
vi.mock('@/lib/bookkeeping/ledger-coverage', () => ({ ledgerCoveredThrough: covered }))

vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()
  return { ...actual, detectBookingDuplicate: vi.fn() }
})

const TX_OUT = '11111111-1111-4111-8111-111111111111'
const JE = '33333333-3333-4333-8333-333333333333'

const transferOut = {
  id: TX_OUT,
  amount: -5000,
  currency: 'SEK',
  description: 'Överföring sparkonto',
  merchant_name: null,
  date: '2026-10-20',
  journal_entry_id: null,
  cash_account_id: 'cash-1930',
}

const TX_LATER = '22222222-2222-4222-8222-222222222222'
const stripeFee = {
  ...transferOut,
  amount: -37.5,
  description: 'Stripe-avgift',
  cash_account_id: 'cash-1686',
  import_source: 'stripe',
}

const line = (account_number: string, debit_amount: number, credit_amount: number) => ({
  account_number,
  debit_amount,
  credit_amount,
  currency: 'SEK',
})

function run(supabase: unknown, body: Partial<BulkBookInput>) {
  return bulkBookTransactions(
    { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') },
    { tx_ids: [TX_OUT], ...body } as BulkBookInput,
    { dryRun: true },
  )
}

const messageOf = (outcome: unknown) => (outcome as { messageSv?: string }).messageSv ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
  covered.mockResolvedValue(null)
})

describe('bankNetMismatch: the RPC bank net', () => {
  it('passes lines that move the row\'s account by its amount', () => {
    expect(bankNetMismatch([{ ledger: '1930', amount: -5000 }], [line('6570', 5000, 0), line('1930', 0, 5000)])).toBeNull()
  })

  it('names a transfer between own cash accounts: the row\'s account moves right, another 19xx account cancels it', () => {
    const transfer = [line('1931', 5000, 0), line('1930', 0, 5000)]
    expect(bankNetMismatch([{ ledger: '1930', amount: -5000 }], transfer)).toEqual({
      tx_sum: -5000,
      lines_bank_net: 0,
      transfer_accounts: ['1931'],
    })
    expect(bankNetMismatch([{ ledger: '1931', amount: 5000 }], transfer)).toEqual({
      tx_sum: 5000,
      lines_bank_net: 0,
      transfer_accounts: ['1930'],
    })
  })

  it('reports the rows\' sum against what the lines move on their ledger', () => {
    expect(bankNetMismatch([{ ledger: '1930', amount: -5000 }], [line('6570', 4000, 0), line('1930', 0, 4000)])).toEqual({
      tx_sum: -5000,
      lines_bank_net: -4000,
      account: '1930',
      account_tx_sum: -5000,
      account_net: -4000,
    })
  })

  it('names the ledger when the total is right but split over the wrong ledgers', () => {
    const rows = [
      { ledger: '1930', amount: 100 },
      { ledger: '1686', amount: 25 },
    ]
    expect(bankNetMismatch(rows, [line('1930', 25, 0), line('1686', 100, 0), line('3001', 0, 125)])).toEqual({
      tx_sum: 125,
      lines_bank_net: 125,
      account: '1686',
      account_tx_sum: 25,
      account_net: 100,
    })
  })

  it('measures a Stripe balance on 1686 alone: its payout to 1930 passes', () => {
    expect(bankNetMismatch([{ ledger: '1686', amount: -1000 }], [line('1930', 1000, 0), line('1686', 0, 1000)])).toBeNull()
  })

  it('reads the string amounts PostgREST returns for numeric columns', () => {
    const lines = [
      { account_number: '1930', debit_amount: '0', credit_amount: '12.34' },
      { account_number: '6570', debit_amount: '12.34', credit_amount: '0' },
    ]
    expect(bankNetMismatch([{ ledger: '1930', amount: -12.34 }], lines)).toBeNull()
  })
})

describe('bulk booking dry run (what staging runs)', () => {
  it('refuses manual lines that balance only before each line is rounded', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null }) // transactions

    const outcome = await run(supabase, {
      entry_description: 'Tre decimaler',
      manual_lines: [line('6570', 100.004, 0), line('6571', 100.004, 0), line('1930', 0, 200.01)],
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_UNBALANCED',
      details: { total_debit: 200, total_credit: 200.01 },
    })
  })

  it('refuses the crm#1501 transfer at staging and names the doors that book it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null }) // transactions
    enqueue({
      data: [
        { account_number: '1930', is_active: true },
        { account_number: '1931', is_active: true },
      ],
      error: null,
    }) // chart_of_accounts
    enqueue({ data: [], error: null }) // account_dimension_rules
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null }) // the row's cash account

    const outcome = await run(supabase, {
      entry_description: 'Överföring till sparkonto',
      manual_lines: [line('1931', 5000, 0), line('1930', 0, 5000)],
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { tx_sum: -5000, lines_bank_net: 0, transfer_accounts: ['1931'], bank_accounts: ['1930'] },
    })
    expect(messageOf(outcome)).toContain('överföring mellan egna konton (1930 och 1931)')
    expect(messageOf(outcome)).toContain('categorize_transaction med account_override 1931')
    expect(messageOf(outcome)).toContain('link_transaction_to_journal_entry')
  })

  it('refuses a new samlingsverifikat over Stripe rows on days the ledger already covers, with one read', async () => {
    covered.mockResolvedValue('2026-10-20')
    const second = { ...stripeFee, id: TX_LATER, amount: -37.5 }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [second, stripeFee], error: null })
    enqueue({ data: [{ account_number: '1686', is_active: true }, { account_number: '6570', is_active: true }], error: null })
    enqueue({ data: { ledger_account: '1686', currency: 'SEK' }, error: null })

    const outcome = await run(supabase, {
      tx_ids: [TX_LATER, TX_OUT],
      entry_description: 'Stripeavgifter',
      manual_lines: [line('6570', 75, 0), line('1686', 0, 75)],
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_LEDGER_DAY_COVERED',
      details: { transaction_id: TX_LATER, covered_through: '2026-10-20', settlement_account: '1686' },
    })
    // One read per settlement account, not one per row.
    expect(covered).toHaveBeenCalledTimes(1)
    expect(covered).toHaveBeenCalledWith(supabase, 'company-1', ['1686'], '2026-10-20')
  })

  it('never reads coverage for bank rows', async () => {
    covered.mockResolvedValue('2026-12-31')
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null })
    enqueue({ data: [{ account_number: '1930', is_active: true }, { account_number: '6570', is_active: true }], error: null })
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null })

    await run(supabase, {
      entry_description: 'Bankavgift',
      manual_lines: [line('6570', 5000, 0), line('1930', 0, 5000)],
    })

    expect(covered).not.toHaveBeenCalled()
  })

  it('refuses a bulk link of a transfer\'s row to its verifikat, pointing at the single link', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null })
    enqueue({
      data: {
        id: JE,
        status: 'posted',
        entry_date: '2026-10-20',
        journal_entry_lines: [
          { account_number: '1931', debit_amount: '5000', credit_amount: '0' },
          { account_number: '1930', debit_amount: '0', credit_amount: '5000' },
        ],
      },
      error: null,
    }) // link target
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null }) // the row's cash account

    const outcome = await run(supabase, { existing_journal_entry_id: JE })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_AMOUNT_MISMATCH',
      details: { transfer_accounts: ['1931'], link_existing: true },
    })
    expect(messageOf(outcome)).toContain('Koppla raden till verifikationen en och en (link_transaction_to_journal_entry)')
  })

  it('refuses at staging lines that do not move the row\'s account by its amount, naming both amounts', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null })
    enqueue({
      data: [
        { account_number: '1930', is_active: true },
        { account_number: '6570', is_active: true },
      ],
      error: null,
    })
    enqueue({ data: [], error: null }) // account_dimension_rules
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null }) // the row's cash account

    const outcome = await run(supabase, {
      entry_description: 'Bankavgift',
      manual_lines: [line('6570', 4000, 0), line('1930', 0, 4000)],
    })

    expect(outcome).toMatchObject({ ok: false, code: 'BULK_BOOK_AMOUNT_MISMATCH', details: { tx_sum: -5000, lines_bank_net: -4000 } })
    expect(messageOf(outcome)).toMatch(/konto 1930 med \S*5\s000\skr, men raderna rör det med \S*4\s000\skr/)
  })

  it.each(['storno', 'opening_balance'])('refuses at staging a link to a %s, as the other link doors do', async (source_type) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null })
    enqueue({
      data: {
        id: JE,
        status: 'posted',
        entry_date: '2026-10-20',
        source_type,
        journal_entry_lines: [
          { account_number: '2440', debit_amount: '5000', credit_amount: '0' },
          { account_number: '1930', debit_amount: '0', credit_amount: '5000' },
        ],
      },
      error: null,
    })

    expect(await run(supabase, { existing_journal_entry_id: JE })).toMatchObject({
      ok: false,
      code: 'LINK_TX_JE_NOT_BANK_MOVEMENT',
      details: { source_type },
    })
  })

  it('stages a link whose verifikat moves the row\'s account by its amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null })
    enqueue({
      data: {
        id: JE,
        status: 'posted',
        entry_date: '2026-10-20',
        journal_entry_lines: [
          { account_number: '2440', debit_amount: '5000', credit_amount: '0' },
          { account_number: '1930', debit_amount: '0', credit_amount: '5000' },
        ],
      },
      error: null,
    })
    enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null })

    const outcome = await run(supabase, { existing_journal_entry_id: JE })

    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { mode: 'link_existing', tx_sum: -5000 } })
  })

  it('refuses at staging an account that is deactivated or missing from the chart, saying which', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [transferOut], error: null })
    enqueue({
      data: [
        { account_number: '1930', is_active: true },
        { account_number: '6570', is_active: false },
      ],
      error: null,
    })

    const outcome = await run(supabase, {
      entry_description: 'Bankavgift',
      manual_lines: [line('6570', 4000, 0), line('2645', 1000, 0), line('1930', 0, 5000)],
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_INVALID_ACCOUNT',
      details: { invalid_accounts: ['2645', '6570'], inactive_accounts: ['6570'], not_in_chart: ['2645'] },
    })
  })

  it('refuses at staging a row booked through a voucher link, which the RPC refuses at commit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ ...transferOut, transaction_voucher_links: [{ journal_entry_id: JE }] }] })

    expect(await run(supabase, { existing_journal_entry_id: JE })).toMatchObject({
      ok: false,
      code: 'BULK_BOOK_TX_ALREADY_BOOKED',
      details: { tx_id: TX_OUT, via: 'transaction_voucher_links' },
    })
  })

  it('refuses an ignored row, on a dry run and a commit alike: it can carry no verifikat', async () => {
    for (const dryRun of [true, false]) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: [{ ...transferOut, is_ignored: true }] })

      const outcome = await bulkBookTransactions(
        { supabase: supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') },
        { tx_ids: [TX_OUT], existing_journal_entry_id: JE } as BulkBookInput,
        { dryRun },
      )

      expect(outcome).toMatchObject({ ok: false, code: 'BANK_ROW_IGNORED', details: { tx_id: TX_OUT } })
    }
  })
})
