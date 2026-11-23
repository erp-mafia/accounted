/**
 * A typed verifikat meets the bank rows that are already in (crm#1958).
 *
 * The real sweep and the real matcher run here against per-table answers:
 * what is under test is that posting one verifikat reaches the matcher with
 * the right account, window and filter, and that the matcher's own rule then
 * decides. The first case is the reported one: a bank booking was reversed
 * and the same payment typed again by hand on the same date, and the bank row
 * stayed open beside the verifikat that books it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase, makeTransaction, type TableMockResult } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import type { UnlinkedGLLine } from '../bank-reconciliation'
import { linkOpenBankRowsToVoucher } from '../voucher-bank-link'

vi.mock('@/lib/supabase/server')

const CASH_1930 = {
  id: '11111111-1111-4111-8111-111111111111',
  ledger_account: '1930',
  currency: 'SEK',
  is_primary: true,
}

const VOUCHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_VOUCHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ROW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_ROW_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** The typed verifikat's line on the bank account, as get_unlinked_gl_lines answers it. */
function typedLine(overrides: Partial<UnlinkedGLLine> = {}): UnlinkedGLLine {
  return {
    line_id: 'line-typed',
    journal_entry_id: VOUCHER_ID,
    debit_amount: 0,
    credit_amount: 61.25,
    line_description: 'Företagskonto / checkkonto',
    entry_date: '2026-09-01',
    voucher_number: 48,
    voucher_series: 'A',
    entry_description: 'Bank till kortskuld',
    source_type: 'manual',
    ...overrides,
  }
}

/** Another unlinked verifikat that books the same money on the same account. */
function otherLine(overrides: Partial<UnlinkedGLLine> = {}): UnlinkedGLLine {
  return typedLine({ line_id: 'line-other', journal_entry_id: OTHER_VOUCHER_ID, voucher_number: 12, ...overrides })
}

/** The autogiro row the bank feed imported weeks before the verifikat was typed. */
function openRow(overrides: Record<string, unknown> = {}) {
  return makeTransaction({
    id: ROW_ID,
    date: '2026-09-01',
    amount: -61.25,
    currency: 'SEK',
    description: 'Autogiro',
    journal_entry_id: null,
    cash_account_id: CASH_1930.id,
    ...overrides,
  })
}

const TYPED_VOUCHER = {
  journalEntryId: VOUCHER_ID,
  entryDate: '2026-09-01',
  lines: [{ account_number: '1930' }, { account_number: '2890' }],
}

/**
 * The database as the sweep reads and writes it: the company's cash accounts,
 * the unlinked verifikat lines and the open bank rows of the account in the
 * window (the mock applies no filter, so each case hands it what the database
 * would answer), and a write on a bank row answering with the row.
 */
function makeDb(state: { cashAccounts?: TableMockResult; glLines?: TableMockResult; openRows?: unknown[] }) {
  const glLines = state.glLines ?? { data: [] }
  return createTableMockSupabase({
    cash_accounts: state.cashAccounts ?? { data: [CASH_1930] },
    // get_unlinked_gl_lines' answer, read in its two halves: the narrowing
    // names the lines' verifikat, the predicate answers the lines. A failed
    // read fails at the narrowing.
    'rpc:bank_account_unlinked_entries': glLines.error
      ? glLines
      : { data: [...new Set(((glLines.data ?? []) as UnlinkedGLLine[]).map((line) => line.journal_entry_id))] },
    'rpc:bank_account_unlinked_lines': glLines,
    open_bank_rows: { data: state.openRows ?? [] },
    account_reconciliation_settlements: { data: [] },
    transactions: (chain) => (chain.some((call) => call.method === 'update') ? { data: [{ id: 'updated' }] } : { data: null }),
  })
}

type Db = ReturnType<typeof makeDb>

/** Every update written on a bank row, and whether one named this row. */
const rowWrites = (db: Db) => db.payloads('transactions', 'update') as Array<Record<string, unknown>>
const wroteRow = (db: Db, id: string) => db.findCalls('transactions', 'eq').some(([column, value]) => column === 'id' && value === id)

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

async function run(db: Db, voucher = TYPED_VOUCHER) {
  const log = makeLog()
  const result = await linkOpenBankRowsToVoucher(db.supabase as never, 'company-1', 'user-1', voucher, log as never)
  return { result, log }
}

describe('linkOpenBankRowsToVoucher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('links the open bank row a typed verifikat books: same account, date and amount (crm#1958)', async () => {
    const db = makeDb({ glLines: { data: [typedLine()] }, openRows: [openRow()] })

    const { result } = await run(db)

    expect(result).toEqual({ linked: 1, suggested: 0 })
    expect(rowWrites(db)).toHaveLength(1)
    expect(rowWrites(db)[0]).toMatchObject({
      journal_entry_id: VOUCHER_ID,
      reconciliation_method: 'auto_exact',
      is_business: true,
    })
    expect(wroteRow(db, ROW_ID)).toBe(true)
  })

  it("asks the matcher about the verifikat's own accounts, inside the reach of its date rule", async () => {
    const db = makeDb({ glLines: { data: [typedLine()] }, openRows: [openRow()] })

    await run(db)

    const reads = db.findCalls('rpc:bank_account_unlinked_entries', 'rpc')
    expect(reads.length).toBeGreaterThan(0)
    for (const [args] of reads) {
      expect(args).toMatchObject({
        p_company_id: 'company-1',
        p_account_number: '1930',
        p_date_from: '2026-08-29',
        p_date_to: '2026-09-04',
      })
    }
  })

  it('leaves a suggestion on the row, not a link, when the verifikat is dated a day off', async () => {
    const db = makeDb({ glLines: { data: [typedLine({ entry_date: '2026-08-31' })] }, openRows: [openRow()] })

    const { result } = await run(db, { ...TYPED_VOUCHER, entryDate: '2026-08-31' })

    expect(result).toEqual({ linked: 0, suggested: 1 })
    expect(rowWrites(db)).toHaveLength(1)
    expect(rowWrites(db)[0]).toMatchObject({
      potential_journal_entry_id: VOUCHER_ID,
      potential_match_method: 'auto_date_range',
    })
    expect(rowWrites(db)[0]).not.toHaveProperty('journal_entry_id')
    expect(wroteRow(db, ROW_ID)).toBe(true)
  })

  it('does not guess between two open rows that fit equally: both stay for a person to pick', async () => {
    const db = makeDb({
      glLines: { data: [typedLine()] },
      openRows: [openRow(), openRow({ id: OTHER_ROW_ID })],
    })

    const { result } = await run(db)

    expect(result).toEqual({ linked: 0, suggested: 0 })
    expect(rowWrites(db)).toEqual([])
  })

  it.each([
    ['posted before it in the ledger order', 12],
    ['posted after it in the ledger order', 60],
  ])('never takes a row another unlinked verifikat books as well (%s)', async (_order, voucherNumber) => {
    const lines = [typedLine(), otherLine({ voucher_number: voucherNumber })].sort((a, b) => a.voucher_number - b.voucher_number)
    const db = makeDb({ glLines: { data: lines }, openRows: [openRow()] })

    const { result } = await run(db)

    expect(result).toEqual({ linked: 0, suggested: 0 })
    expect(rowWrites(db)).toEqual([])
  })

  it('still links the exact pair when the only rivals are weaker: a verifikat and a row a day off', async () => {
    const db = makeDb({
      glLines: { data: [otherLine({ entry_date: '2026-08-31' }), typedLine()] },
      openRows: [openRow(), openRow({ id: OTHER_ROW_ID, date: '2026-09-02' })],
    })

    const { result } = await run(db)

    expect(result).toEqual({ linked: 1, suggested: 0 })
    expect(rowWrites(db)).toHaveLength(1)
    expect(rowWrites(db)[0]).toMatchObject({ journal_entry_id: VOUCHER_ID, reconciliation_method: 'auto_exact' })
    expect(wroteRow(db, ROW_ID)).toBe(true)
    expect(wroteRow(db, OTHER_ROW_ID)).toBe(false)
  })

  it('reads nothing but the cash accounts for a verifikat with no line on a bank-fed account', async () => {
    const db = makeDb({ glLines: { data: [typedLine()] }, openRows: [openRow()] })

    const { result } = await run(db, {
      ...TYPED_VOUCHER,
      lines: [{ account_number: '5420' }, { account_number: '2641' }, { account_number: '2440' }],
    })

    expect(result).toEqual({ linked: 0, suggested: 0 })
    expect(db.tables()).toEqual(['cash_accounts'])
    expect(db.supabase.rpc).not.toHaveBeenCalled()
  })

  it('asks about a bank-fed account outside the 19xx range too: cash_accounts decides, never an account range', async () => {
    const card = { id: '22222222-2222-4222-8222-222222222222', ledger_account: '2890', currency: 'SEK', is_primary: false }
    const db = makeDb({ cashAccounts: { data: [CASH_1930, card] } })

    await run(db)

    const asked = db.findCalls('rpc:bank_account_unlinked_entries', 'rpc').map(([args]) => (args as { p_account_number: string }).p_account_number)
    expect(asked).toEqual(['1930', '2890'])
  })

  it('never fails the posting when the matcher cannot run: the row stays open and the failure is logged', async () => {
    const db = makeDb({ cashAccounts: { data: null, error: { message: 'connection reset' } } })

    const { result, log } = await run(db)

    expect(result).toEqual({ linked: 0, suggested: 0 })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(rowWrites(db)).toEqual([])
  })

  it('says so when an account run failed, and links nothing', async () => {
    const db = makeDb({ glLines: { data: null, error: { message: 'statement timeout' } }, openRows: [openRow()] })

    const { result, log } = await run(db)

    expect(result).toEqual({ linked: 0, suggested: 0 })
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(rowWrites(db)).toEqual([])
  })
})
