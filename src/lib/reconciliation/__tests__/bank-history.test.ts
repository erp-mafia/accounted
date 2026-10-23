/**
 * The bank's history (crm#1221): verifikat dated before the first day the
 * bank side covers leave the comparison, which starts there, the model the
 * skattekonto reconciliation has (skattekonto-reconciliation.test.ts).
 *
 * The status tests run the engine on the answer of its facts read; the read's
 * own rules for this shape are pinned against Postgres in
 * tests/pg/bank-reconciliation-facts.pg.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { getReconciliationStatus, splitBeforeBankHistory } from '../bank-reconciliation'

vi.mock('@/lib/supabase/server')


const COMPANY = 'company-1'
const CASH = '11111111-1111-4111-8111-111111111111'

/**
 * The crm#1221 shape, as get_bank_reconciliation_facts answers it (the SQL
 * side of this shape is pinned in tests/pg/bank-reconciliation-facts.pg.test.ts):
 * an imported year on 1930 (IB 10 000 on 2026-01-01, then +5 000 on 03-10 and
 * -2 000 on 05-20 from before the bank connection), then the bank feed from
 * 2026-07-20 with every row linked to its verifikat (+1 000 on 07-20, -300 on
 * 08-05). The two imported verifikat are the ledger-only lines; the bank last
 * reported 13 700 on 2026-10-15.
 */
function imported(extra: {
  bank?: Partial<ReturnType<typeof base>['bank']>
  gl?: Partial<ReturnType<typeof base>['gl']>
  candidates?: ReturnType<typeof base>['candidates']
  saldo?: ReturnType<typeof base>['saldo']
  ib_floor?: string | null
  effective_from?: string | null
} = {}) {
  const b = base()
  return {
    ...b,
    ...('ib_floor' in extra ? { ib_floor: extra.ib_floor } : {}),
    ...('effective_from' in extra ? { effective_from: extra.effective_from } : {}),
    gl: { ...b.gl, ...extra.gl },
    bank: { ...b.bank, ...extra.bank },
    candidates: extra.candidates ?? b.candidates,
    saldo: 'saldo' in extra ? extra.saldo : b.saldo,
  }
}

function candidate(id: string, date: string, amount: number, voucherNumber: number) {
  return {
    line_id: `line-${id}`,
    journal_entry_id: id,
    debit_amount: amount > 0 ? amount : 0,
    credit_amount: amount < 0 ? -amount : 0,
    line_description: null,
    entry_date: date,
    voucher_number: voucherNumber,
    voucher_series: 'A',
    entry_description: id,
    source_type: 'import',
    linked_transaction_count: 0,
    remaining_amount: null,
  }
}

function base() {
  return {
    ib_floor: '2026-01-01' as string | null,
    effective_from: '2026-01-01' as string | null,
    gl: { balance: 13700, opening_balance: 10000, correction_adjustment: 0, unconvertible_line_count: 0 },
    bank: {
      count: 2,
      total: 700,
      inflow: 1000,
      outflow: -300,
      ignored_count: 0,
      ignored_total: 0,
      matched_count: 2,
      unmatched_count: 0,
      unmatched_total: 0,
      history_start: '2026-07-20' as string | null,
    },
    read_window_cash_accounts: null,
    saldo: {
      balance: 13700,
      balance_updated_at: '2026-10-15T05:00:00Z',
      balance_date: '2026-10-15',
      rows_total: 700,
    } as { balance: number | null; balance_updated_at: string | null; balance_date: string | null; rows_total: number | null } | null,
    candidates: [candidate('imp-1', '2026-03-10', 5000, 1), candidate('imp-2', '2026-05-20', -2000, 2)],
    entry_amounts: null,
  }
}

/** A client whose facts read answers `facts` and whose settlement read finds none. */
function status(facts: ReturnType<typeof imported>, dateFrom?: string, dateTo?: string) {
  const answers: Record<string, TableMockResolver> = {
    'rpc:get_bank_reconciliation_facts': () => ({ data: facts }),
    account_reconciliation_settlements: () => ({ data: [] }),
  }
  const { supabase } = createTableMockSupabase(answers)
  return getReconciliationStatus(supabase as never, COMPANY, dateFrom, dateTo, '1930', 'SEK', CASH, true)
}

describe('getReconciliationStatus: the bank history (crm#1221)', () => {
  it('moves the verifikat before the first bank row out of the difference, the counts and the movement', async () => {
    const s = await status(imported())

    expect(s.history_start).toBe('2026-07-20')
    expect(s.before_history_count).toBe(2)
    expect(s.before_history_total).toBe(3000)
    // Movement from the history start: 1000 - 300, not 5000 - 2000 + 1000 - 300.
    expect(s.gl_1930_period_movement).toBe(700)
    expect(s.bank_transaction_total).toBe(700)
    expect(s.difference).toBe(0)
    expect(s.unmatched_gl_line_count).toBe(0)
    expect(s.unmatched_gl_line_total).toBe(0)
    expect(s.unexplained_difference).toBe(0)
    expect(s.is_reconciled).toBe(true)
    // The balance itself never moves: it is the balansräkning figure.
    expect(s.gl_1930_balance).toBe(13700)
  })

  it('leaves the unexplained difference exactly where the whole-window comparison has it', async () => {
    const split = await status(imported())
    // Without a history start the whole window is compared, as before the split.
    const whole = await status(imported({ bank: { history_start: null } }))

    expect(whole.history_start).toBeNull()
    expect(whole.before_history_count).toBe(0)
    expect(whole.difference).toBe(-3000)
    expect(whole.unmatched_gl_line_count).toBe(2)
    expect(whole.is_reconciled).toBe(false)
    expect(whole.opening_difference).toBeNull()
    expect(split.unexplained_difference).toBe(whole.unexplained_difference)
  })

  it('compares the ledger before the history with the bank saldo that day, once', async () => {
    const agrees = await status(imported())
    // IB 10 000 + the two verifikat before the history (3 000).
    expect(agrees.ledger_balance_before_start).toBe(13000)
    // The reported 13 700 less the 700 the bank moved since its first row.
    expect(agrees.saldo_at_start).toBe(13000)
    expect(agrees.opening_difference).toBe(0)

    const differs = await status(imported({ saldo: { ...base().saldo!, balance: 14700 } }))
    expect(differs.opening_difference).toBe(1000)
    // Informational: the comparison from the history start still reconciles.
    expect(differs.is_reconciled).toBe(true)
    expect(differs.difference).toBe(0)

    const unknown = await status(imported({ saldo: { ...base().saldo!, balance: null, balance_updated_at: null, balance_date: null, rows_total: null } }))
    expect(unknown.saldo_at_start).toBeNull()
    expect(unknown.opening_difference).toBeNull()
    expect(unknown.ledger_balance_before_start).toBe(13000)

    // A balance dated before the bank's first row says nothing about it.
    const older = await status(imported({ saldo: { ...base().saldo!, balance_updated_at: '2026-07-01T05:00:00Z', balance_date: '2026-07-01', rows_total: 0 } }))
    expect(older.saldo_at_start).toBeNull()
  })

  it('takes the bank saldo through the balance day, past the window end', async () => {
    // Window to 2026-09-30; the bank reported 13 750 on 2026-10-15, after a
    // +50 row on 2026-10-02: the read sums the rows through the balance day.
    const s = await status(imported({ saldo: { ...base().saldo!, balance: 13750, rows_total: 750 } }), undefined, '2026-09-30')
    expect(s.before_history_count).toBe(2)
    expect(s.difference).toBe(0)
    expect(s.saldo_at_start).toBe(13000)
    expect(s.opening_difference).toBe(0)
  })

  it('keeps a verifikat before the history start that a bank row is linked to in the comparison', async () => {
    // Booked the day before the first bank row (+400 on 07-19), which is
    // linked to it: no ledger-only line, and the movement carries it.
    const s = await status(
      imported({
        gl: { balance: 14100 },
        bank: { count: 3, total: 1100, inflow: 1400, matched_count: 3 },
        saldo: { ...base().saldo!, balance: 14100, rows_total: 1100 },
      }),
    )
    expect(s.before_history_count).toBe(2)
    expect(s.gl_1930_period_movement).toBe(1100)
    expect(s.bank_transaction_total).toBe(1100)
    expect(s.difference).toBe(0)
    expect(s.ledger_balance_before_start).toBe(13000)
    expect(s.opening_difference).toBe(0)
  })

  it('an older bank file moves the history start back and the verifikat become matchable again', async () => {
    const s = await status(
      imported({
        bank: { count: 3, total: 5700, inflow: 6000, unmatched_count: 1, unmatched_total: 5000, history_start: '2026-03-10' },
      }),
    )
    expect(s.history_start).toBe('2026-03-10')
    expect(s.before_history_count).toBe(0)
    // Both verifikat are back on the list: the March one has its bank row now.
    expect(s.unmatched_gl_line_count).toBe(2)
    expect(s.unmatched_transaction_count).toBe(1)
  })

  it('splits nothing when the window starts inside the history', async () => {
    const s = await status(
      imported({
        ib_floor: null,
        effective_from: '2026-08-01',
        gl: { balance: -300, opening_balance: 0 },
        bank: { count: 1, total: -300, inflow: 0, outflow: -300, matched_count: 1 },
        candidates: [],
      }),
      '2026-08-01',
      '2026-08-31',
    )
    expect(s.history_start).toBe('2026-07-20')
    expect(s.before_history_count).toBe(0)
    expect(s.before_history_total).toBe(0)
    expect(s.opening_difference).toBeNull()
    expect(s.difference).toBe(0)
  })

  it('splits nothing when the window ends before the history: the verifikat stay missing on the bank', async () => {
    const s = await status(
      imported({
        gl: { balance: 13000 },
        bank: { count: 0, total: 0, inflow: 0, outflow: 0, matched_count: 0 },
      }),
      '2026-01-01',
      '2026-06-30',
    )
    expect(s.history_start).toBe('2026-07-20')
    expect(s.before_history_count).toBe(0)
    expect(s.unmatched_gl_line_count).toBe(2)
    expect(s.difference).toBe(-3000)
    expect(s.is_reconciled).toBe(false)
  })
})

describe('splitBeforeBankHistory', () => {
  const lines = [
    { journal_entry_id: 'a', entry_date: '2026-03-01' },
    { journal_entry_id: 'b', entry_date: '2026-04-01' },
    { journal_entry_id: 'b', entry_date: '2026-04-01' },
    { journal_entry_id: 'c', entry_date: '2026-08-01' },
    { journal_entry_id: 'settled', entry_date: '2026-02-01' },
  ]
  const open = new Map<string, number | null>([
    ['a', 100],
    ['b', -40],
    ['c', 7],
    ['settled', 55],
  ])
  const base = {
    historyStart: '2026-07-01',
    windowFrom: '2026-01-01',
    windowTo: '2026-12-31',
    lines,
    openByEntry: open,
    settledEntryIds: new Set(['settled']),
    entryAmount: () => null,
  }

  it('takes the open, unsettled verifikat dated before the history start, once each', () => {
    const split = splitBeforeBankHistory(base)
    expect(split.splitAt).toBe('2026-07-01')
    expect([...split.entryIds]).toEqual(['a', 'b'])
    expect(split.total).toBe(60)
  })

  it('splits nothing without a history, or when the history start is outside the window', () => {
    for (const input of [
      { ...base, historyStart: null },
      { ...base, historyStart: '2026-01-01' },
      { ...base, historyStart: '2025-12-31' },
      { ...base, historyStart: '2027-01-01' },
    ]) {
      expect(splitBeforeBankHistory(input)).toEqual({ splitAt: null, entryIds: new Set(), total: 0 })
    }
    // No lower bound: any history start splits.
    expect(splitBeforeBankHistory({ ...base, windowFrom: null }).splitAt).toBe('2026-07-01')
  })

  it("takes a verifikat's amount from its counted lines when the candidate carries none in the currency", () => {
    const foreign = new Map<string, number | null>([['a', null], ['b', null]])
    const split = splitBeforeBankHistory({
      ...base,
      openByEntry: foreign,
      entryAmount: (id) => (id === 'a' ? 9 : 1),
    })
    expect(split.total).toBe(10)
    // An amount nothing can express keeps the whole window in the comparison.
    expect(splitBeforeBankHistory({ ...base, openByEntry: foreign }).splitAt).toBeNull()
  })
})
