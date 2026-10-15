/**
 * The bank's history (crm#1221): verifikat dated before the first day the
 * bank side covers leave the comparison, which starts there, the model the
 * skattekonto reconciliation has (skattekonto-reconciliation.test.ts).
 *
 * The status tests run the real engine against a small in-memory table set,
 * so the figures come out of the same reads production makes.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { getReconciliationStatus, splitBeforeBankHistory } from '../bank-reconciliation'

vi.mock('@/lib/supabase/server')

type Row = Record<string, unknown>

/**
 * An answer over in-memory rows, computed from the chain that asked:
 * eq / in / gte / lte / gt / lt / is filter on the columns a row has (a
 * column the row lacks passes), the first order applies, range pages, limit
 * shortens, maybeSingle returns the first row. A read whose select is
 * `failSelect` fails.
 */
function rowsAnswer(rows: () => Row[], failSelect?: string): TableMockResolver {
  return (chain) => {
    const select = String(chain.find((c) => c.method === 'select')?.args[0] ?? '')
    if (failSelect && select === failSelect) return { data: null, error: { message: 'boom' } }
    const has = (r: Row, c: unknown) => r[String(c)] !== undefined
    const value = (r: Row, c: unknown) => String(r[String(c)])
    let out = rows()
    let orderBy: { column: string; ascending: boolean } | null = null
    let range: [number, number] | null = null
    let limit: number | null = null
    let single = false
    for (const { method, args } of chain) {
      const [c, v] = args
      if (method === 'eq' || method === 'is') out = out.filter((r) => !has(r, c) || r[String(c)] === v)
      else if (method === 'in') out = out.filter((r) => !has(r, c) || (v as unknown[]).includes(r[String(c)]))
      else if (method === 'gte') out = out.filter((r) => !has(r, c) || value(r, c) >= String(v))
      else if (method === 'lte') out = out.filter((r) => !has(r, c) || value(r, c) <= String(v))
      else if (method === 'gt') out = out.filter((r) => !has(r, c) || value(r, c) > String(v))
      else if (method === 'lt') out = out.filter((r) => !has(r, c) || value(r, c) < String(v))
      else if (method === 'order' && !orderBy) {
        orderBy = { column: String(c), ascending: (v as { ascending?: boolean } | undefined)?.ascending !== false }
      } else if (method === 'range') range = [Number(c), Number(v)]
      else if (method === 'limit') limit = Number(c)
      else if (method === 'maybeSingle' || method === 'single') single = true
    }
    if (orderBy) {
      const { column, ascending } = orderBy
      out = [...out].sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (ascending ? 1 : -1))
    }
    if (range) out = out.slice(range[0], range[1] + 1)
    if (limit !== null) out = out.slice(0, limit)
    return { data: single ? (out[0] ?? null) : out }
  }
}

function memorySupabase(
  tables: Record<string, Row[]>,
  rpcs: Record<string, (args: Record<string, unknown>) => Row[]> = {},
  failSelect?: string,
) {
  const answers: Record<string, TableMockResolver> = {}
  for (const [table, rows] of Object.entries(tables)) answers[table] = rowsAnswer(() => rows, failSelect)
  // An RPC's arguments are on its rpc() call, the latest one being the read
  // in flight: every reader here awaits its RPC before the next.
  let mock: ReturnType<typeof createTableMockSupabase> | null = null
  for (const [name, fn] of Object.entries(rpcs)) {
    const key = `rpc:${name}`
    answers[key] = rowsAnswer(() => fn((mock?.findCalls(key, 'rpc').at(-1)?.[0] ?? {}) as Record<string, unknown>))
  }
  mock = createTableMockSupabase(answers)
  return mock.supabase
}

const COMPANY = 'company-1'
const CASH = '11111111-1111-4111-8111-111111111111'

interface Voucher {
  id: string
  date: string
  amount: number
  source_type?: string
}

/**
 * The crm#1221 shape: an imported year on 1930 (IB plus two verifikat from
 * before the bank connection), then the bank feed from 2026-07-20 with every
 * row linked to its verifikat.
 */
function ledger(extra: { vouchers?: Voucher[]; transactions?: Row[]; balance?: number | null } = {}) {
  const vouchers: Voucher[] = [
    { id: 'ib', date: '2026-01-01', amount: 10000, source_type: 'opening_balance' },
    { id: 'imp-1', date: '2026-03-10', amount: 5000, source_type: 'import' },
    { id: 'imp-2', date: '2026-05-20', amount: -2000, source_type: 'import' },
    { id: 'je-a', date: '2026-07-20', amount: 1000 },
    { id: 'je-b', date: '2026-08-05', amount: -300 },
    ...(extra.vouchers ?? []),
  ]
  const transactions: Row[] = [
    { id: 'tx-a', date: '2026-07-20', amount: 1000, currency: 'SEK', journal_entry_id: 'je-a', is_ignored: false },
    { id: 'tx-b', date: '2026-08-05', amount: -300, currency: 'SEK', journal_entry_id: 'je-b', is_ignored: false },
    ...(extra.transactions ?? []),
  ]
  const linked = new Set(transactions.map((t) => t.journal_entry_id))
  const entries = vouchers.map((v) => ({
    id: v.id,
    company_id: COMPANY,
    entry_date: v.date,
    status: 'posted',
    source_type: v.source_type ?? 'bank_transaction',
  }))
  const lines = vouchers.map((v) => ({
    id: `line-${v.id}`,
    journal_entry_id: v.id,
    account_number: '1930',
    debit_amount: v.amount > 0 ? v.amount : 0,
    credit_amount: v.amount < 0 ? -v.amount : 0,
  }))
  // The candidate RPC: posted verifikat on the account with no bank link, IB excluded.
  const candidates = vouchers
    .filter((v) => v.source_type !== 'opening_balance' && !linked.has(v.id))
    .map((v, i) => ({
      line_id: `line-${v.id}`,
      journal_entry_id: v.id,
      debit_amount: v.amount > 0 ? v.amount : 0,
      credit_amount: v.amount < 0 ? -v.amount : 0,
      entry_date: v.date,
      voucher_number: i + 1,
      voucher_series: 'A',
      entry_description: v.id,
      source_type: v.source_type ?? 'manual',
      linked_transaction_count: 0,
    }))
  const balance = extra.balance === undefined ? 13700 : extra.balance
  return {
    tables: {
      transactions,
      journal_entries: entries,
      journal_entry_lines: lines,
      cash_accounts: [
        { id: CASH, company_id: COMPANY, balance, balance_updated_at: balance === null ? null : '2026-10-15T05:00:00Z' },
      ],
    },
    rpcs: {
      get_account_gl_lines_for_matching: (args: Record<string, unknown>) =>
        candidates.filter(
          (c) =>
            (!args.p_date_from || c.entry_date >= String(args.p_date_from)) &&
            (!args.p_date_to || c.entry_date <= String(args.p_date_to)),
        ),
    },
  }
}

function status(setup: ReturnType<typeof ledger>, dateFrom?: string, dateTo?: string, failSelect?: string) {
  const supabase = memorySupabase(setup.tables, setup.rpcs, failSelect)
  return getReconciliationStatus(supabase as never, COMPANY, dateFrom, dateTo, '1930', 'SEK', CASH, true)
}

describe('getReconciliationStatus: the bank history (crm#1221)', () => {
  it('moves the verifikat before the first bank row out of the difference, the counts and the movement', async () => {
    const s = await status(ledger())

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
    const split = await status(ledger())
    // The history read fails: the whole window is compared, as before the split.
    const whole = await status(ledger(), undefined, undefined, 'date')

    expect(whole.history_start).toBeNull()
    expect(whole.before_history_count).toBe(0)
    expect(whole.difference).toBe(-3000)
    expect(whole.unmatched_gl_line_count).toBe(2)
    expect(whole.is_reconciled).toBe(false)
    expect(whole.opening_difference).toBeNull()
    expect(split.unexplained_difference).toBe(whole.unexplained_difference)
  })

  it('compares the ledger before the history with the bank saldo that day, once', async () => {
    const agrees = await status(ledger({ balance: 13700 }))
    // IB 10 000 + the two verifikat before the history (3 000).
    expect(agrees.ledger_balance_before_start).toBe(13000)
    // The reported 13 700 less the 700 the bank moved since its first row.
    expect(agrees.saldo_at_start).toBe(13000)
    expect(agrees.opening_difference).toBe(0)

    const differs = await status(ledger({ balance: 14700 }))
    expect(differs.opening_difference).toBe(1000)
    // Informational: the comparison from the history start still reconciles.
    expect(differs.is_reconciled).toBe(true)
    expect(differs.difference).toBe(0)

    const unknown = await status(ledger({ balance: null }))
    expect(unknown.saldo_at_start).toBeNull()
    expect(unknown.opening_difference).toBeNull()
    expect(unknown.ledger_balance_before_start).toBe(13000)
  })

  it('reads the rows between the window end and the balance day for the bank saldo', async () => {
    const s = await status(
      ledger({
        balance: 13750,
        vouchers: [{ id: 'je-d', date: '2026-10-02', amount: 50 }],
        transactions: [{ id: 'tx-d', date: '2026-10-02', amount: 50, currency: 'SEK', journal_entry_id: 'je-d', is_ignored: false }],
      }),
      undefined,
      '2026-09-30',
    )
    expect(s.before_history_count).toBe(2)
    expect(s.difference).toBe(0)
    expect(s.saldo_at_start).toBe(13000)
    expect(s.opening_difference).toBe(0)
  })

  it('keeps a verifikat before the history start that a bank row is linked to in the comparison', async () => {
    // Booked the day before the first bank row, which is linked to it.
    const s = await status(
      ledger({
        balance: 14100,
        vouchers: [{ id: 'je-pre', date: '2026-07-19', amount: 400 }],
        transactions: [{ id: 'tx-c', date: '2026-07-20', amount: 400, currency: 'SEK', journal_entry_id: 'je-pre', is_ignored: false }],
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
      ledger({
        transactions: [{ id: 'tx-file', date: '2026-03-10', amount: 5000, currency: 'SEK', journal_entry_id: null, is_ignored: false }],
      }),
    )
    expect(s.history_start).toBe('2026-03-10')
    expect(s.before_history_count).toBe(0)
    // Both verifikat are back on the list: the March one has its bank row now.
    expect(s.unmatched_gl_line_count).toBe(2)
    expect(s.unmatched_transaction_count).toBe(1)
  })

  it('splits nothing when the window starts inside the history', async () => {
    const s = await status(ledger(), '2026-08-01', '2026-08-31')
    expect(s.history_start).toBe('2026-07-20')
    expect(s.before_history_count).toBe(0)
    expect(s.before_history_total).toBe(0)
    expect(s.opening_difference).toBeNull()
    expect(s.difference).toBe(0)
  })

  it('splits nothing when the window ends before the history: the verifikat stay missing on the bank', async () => {
    const s = await status(ledger(), '2026-01-01', '2026-06-30')
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
