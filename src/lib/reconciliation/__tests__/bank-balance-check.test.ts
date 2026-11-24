import { beforeEach, describe, expect, it, vi } from 'vitest'

const trialBalanceMock = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...args),
}))

import { bankBalanceDay, checkBankBalance, dayEndBalance, type BankBalanceCheckAccount } from '../bank-balance-check'

const COMPANY = 'company-1'
const PERIODS = [
  { id: 'fy-2025', period_start: '2025-01-01', period_end: '2025-12-31' },
  { id: 'fy-2026', period_start: '2026-01-01', period_end: '2026-12-31' },
]

interface Facts {
  history_start: string | null
  rows_count?: number
  rows_total: number
  unbooked_count: number
  unbooked_total: number
  ignored_count: number
  ignored_total: number
}

interface BankRow {
  date: string
  amount: number
  balance_after: number | null
}

/**
 * A client whose reads answer by table: the company's ledger currency, its
 * fiscal periods, the bank rows and get_bank_balance_facts. Records the RPC
 * arguments and how many bank-row reads were made.
 */
function client(
  options: { ledgerCurrency?: string | null; periods?: typeof PERIODS; facts?: Facts; factsError?: string; rows?: BankRow[] } = {},
) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const rowReads = { count: 0 }
  const answer = (data: unknown, error: unknown = null) => Promise.resolve({ data, error })
  const rows = options.rows ?? []
  const supabase = {
    from(table: string) {
      if (table === 'transactions') rowReads.count++
      // The bank-row reads filter on date: through (lte), after (gt) or on (eq).
      const filter: { lte?: string; gt?: string; on?: string } = {}
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'date') filter.on = value
          return chain
        },
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        lte: (_column: string, value: string) => {
          filter.lte = value
          return chain
        },
        gt: (_column: string, value: string) => {
          filter.gt = value
          return chain
        },
        maybeSingle: () => {
          if (table === 'companies') {
            return answer({ ledger_currency: options.ledgerCurrency === undefined ? 'SEK' : options.ledgerCurrency })
          }
          if (table === 'transactions') {
            const dates = rows
              .map((r) => r.date)
              .filter((d) => (filter.lte ? d <= filter.lte : true) && (filter.gt ? d > filter.gt : true))
              .sort()
            const date = filter.lte ? dates[dates.length - 1] : dates[0]
            return answer(date ? { date } : null)
          }
          return answer(null)
        },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          const data =
            table === 'fiscal_periods'
              ? (options.periods ?? PERIODS)
              : table === 'transactions'
                ? rows.filter((r) => r.date === filter.on).map(({ amount, balance_after }) => ({ amount, balance_after }))
                : []
          return answer(data).then(resolve, reject)
        },
      }
      return chain
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      if (options.factsError) return answer(null, { message: options.factsError })
      return answer(
        options.facts ?? {
          history_start: null,
          rows_count: 0,
          rows_total: 0,
          unbooked_count: 0,
          unbooked_total: 0,
          ignored_count: 0,
          ignored_total: 0,
        },
      )
    },
  }
  return { supabase: supabase as never, rpcCalls, rowReads }
}

/** The trial balance answers 1930 = `balances[toDate]` for the fiscal period it is asked about. */
function bookedOn(balances: Record<string, number>) {
  trialBalanceMock.mockImplementation((_s: unknown, _c: unknown, _period: string, opts: { toDate: string }) => {
    const amount = balances[opts.toDate]
    if (amount === undefined) throw new Error(`unexpected trial balance read for ${opts.toDate}`)
    const debit = amount >= 0 ? amount : 0
    const credit = amount < 0 ? -amount : 0
    return Promise.resolve({
      rows: [
        {
          account_number: '1930',
          account_name: 'Företagskonto',
          account_class: 1,
          opening_debit: 0,
          opening_credit: 0,
          period_debit: debit,
          period_credit: credit,
          closing_debit: debit,
          closing_credit: credit,
        },
      ],
      totalDebit: debit,
      totalCredit: credit,
      isBalanced: true,
    })
  })
}

function account(overrides: Partial<BankBalanceCheckAccount> = {}): BankBalanceCheckAccount {
  return {
    id: 'cash-1',
    ledger_account: '1930',
    currency: 'SEK',
    is_primary: true,
    balance: 1000,
    balance_updated_at: '2026-10-26T10:00:00Z',
    balance_reference: null,
    ...overrides,
  }
}

describe('checkBankBalance', () => {
  beforeEach(() => {
    trialBalanceMock.mockReset()
  })

  it('refuses without a balance from the bank', async () => {
    const { supabase } = client()
    expect(await checkBankBalance(supabase, COMPANY, account({ balance: null }))).toEqual({
      check: null,
      refusal: 'NO_BANK_BALANCE',
    })
    expect(await checkBankBalance(supabase, COMPANY, account({ balance_updated_at: null }))).toEqual({
      check: null,
      refusal: 'NO_BANK_BALANCE',
    })
  })

  it('refuses an account kept in another currency than the ledger', async () => {
    const { supabase } = client()
    const result = await checkBankBalance(supabase, COMPANY, account({ currency: 'EUR' }))
    expect(result).toEqual({ check: null, refusal: 'FOREIGN_CURRENCY_ACCOUNT' })
    expect(trialBalanceMock).not.toHaveBeenCalled()
  })

  it('refuses when no fiscal year holds the bank day', async () => {
    const { supabase } = client({ periods: [PERIODS[0]] })
    expect(await checkBankBalance(supabase, COMPANY, account())).toEqual({ check: null, refusal: 'NO_FISCAL_PERIOD' })
  })

  it('splits the difference into unbooked rows, the bank before its history and the rest, to the öre', async () => {
    const { supabase, rpcCalls } = client({
      facts: {
        history_start: '2026-06-01',
        rows_total: 600,
        unbooked_count: 2,
        unbooked_total: 150,
        ignored_count: 1,
        ignored_total: -50,
      },
    })
    bookedOn({ '2026-10-26': 700, '2026-05-31': 300 })

    const result = await checkBankBalance(supabase, COMPANY, account())

    expect(result.refusal).toBeNull()
    expect(result.check).toEqual({
      as_of: '2026-10-26',
      fetched_at: '2026-10-26T10:00:00Z',
      balance_type: null,
      bank_balance: 1000,
      booked_balance: 700,
      difference: 300,
      unbooked: { count: 2, total: 150 },
      // The bank held 1000 - 600 = 400 before its first row; the books 300.
      before_history: { history_start: '2026-06-01', bank_balance: 400, booked_balance: 300, difference: 100 },
      ignored: { count: 1, total: -50 },
      rest: 50,
    })
    const check = result.check!
    expect(check.unbooked.total + check.before_history!.difference + check.rest).toBe(check.difference)
    expect(rpcCalls).toEqual([
      {
        name: 'get_bank_balance_facts',
        args: {
          p_company_id: COMPANY,
          p_cash_account_id: 'cash-1',
          p_include_unassigned: true,
          p_currency: 'SEK',
          p_through: '2026-10-26',
        },
      },
    ])
    // Both sides as the balance sheet reads them: the period holding each day.
    expect(trialBalanceMock.mock.calls.map((c) => [c[2], c[3]])).toEqual(
      expect.arrayContaining([
        ['fy-2026', { closingEntry: 'include', toDate: '2026-10-26' }],
        ['fy-2026', { closingEntry: 'include', toDate: '2026-05-31' }],
      ]),
    )
  })

  it('reads both sides on the Stockholm day of the fetch', async () => {
    // 23:30 UTC on 25 October is 00:30 on the 26th in Stockholm (CET).
    const { supabase, rpcCalls } = client()
    bookedOn({ '2026-10-26': 1000 })
    const result = await checkBankBalance(supabase, COMPANY, account({ balance_updated_at: '2026-10-25T23:30:00Z' }))
    expect(result.check?.as_of).toBe('2026-10-26')
    expect(rpcCalls[0].args.p_through).toBe('2026-10-26')
    expect(result.check?.difference).toBe(0)
  })

  it('reads both sides on the bank\'s own day when it gave one with this balance', async () => {
    // The bank's closingBooked figure is the close of the 25th; a 300 kr
    // verifikat on the 26th is not in it and must not count as a difference.
    const { supabase, rpcCalls } = client()
    bookedOn({ '2026-10-25': 1000 })
    const result = await checkBankBalance(
      supabase,
      COMPANY,
      account({ balance_reference: { date: '2026-10-25', type: 'closingBooked', fetched_at: '2026-10-26T10:00:00+00:00' } }),
    )
    expect(result.check).toMatchObject({ as_of: '2026-10-25', fetched_at: '2026-10-26T10:00:00Z', balance_type: 'closingBooked', difference: 0 })
    expect(rpcCalls[0].args.p_through).toBe('2026-10-25')
  })

  it('counts nothing booked before the first fiscal year', async () => {
    // The bank's history starts on the first day of the company's first year:
    // the day before lies before every fiscal year, where nothing can be booked.
    const { supabase } = client({
      facts: { history_start: '2025-01-01', rows_total: 800, unbooked_count: 0, unbooked_total: 0, ignored_count: 0, ignored_total: 0 },
    })
    bookedOn({ '2026-10-26': 800 })
    const result = await checkBankBalance(supabase, COMPANY, account())
    expect(result.check?.before_history).toEqual({
      history_start: '2025-01-01',
      bank_balance: 200,
      booked_balance: 0,
      difference: 200,
    })
    expect(result.check?.rest).toBe(0)
  })

  it('has no history part without a bank row, and the rest is the whole difference', async () => {
    const { supabase } = client()
    bookedOn({ '2026-10-26': 0 })
    const result = await checkBankBalance(supabase, COMPANY, account({ balance: 25000, is_primary: false }))
    expect(result.check).toMatchObject({ difference: 25000, before_history: null, rest: 25000 })
  })

  it('rounds every part to the öre', async () => {
    const { supabase } = client({
      facts: { history_start: '2026-02-01', rows_total: 0.1 + 0.2, unbooked_count: 1, unbooked_total: 0.1, ignored_count: 0, ignored_total: 0 },
    })
    bookedOn({ '2026-10-26': 0.2, '2026-01-31': 0 })
    const result = await checkBankBalance(supabase, COMPANY, account({ balance: '0.70' }))
    expect(result.check).toMatchObject({
      bank_balance: 0.7,
      difference: 0.5,
      unbooked: { count: 1, total: 0.1 },
      before_history: { bank_balance: 0.4, booked_balance: 0, difference: 0.4 },
      rest: 0,
    })
  })

  it('throws when a read fails rather than reporting a difference', async () => {
    const { supabase } = client({ factsError: 'permission denied' })
    await expect(checkBankBalance(supabase, COMPANY, account())).rejects.toThrow('Kunde inte läsa bankens transaktioner')
  })
})

describe('checkBankBalance on a given day', () => {
  // A UUID id: the bank-row reads assert the scope's shape.
  const ID = '11111111-1111-4111-8111-111111111111'
  // The bank's rows, listed out of order on the 31st: 1 000 at the start of
  // the month, 1 500 after the 30th, 1 250 at the end of the 31st.
  const ROWS: BankRow[] = [
    { date: '2026-10-31', amount: 50, balance_after: 1250 },
    { date: '2026-10-30', amount: 500, balance_after: 1500 },
    { date: '2026-10-31', amount: -300, balance_after: 1200 },
    { date: '2026-11-03', amount: 100, balance_after: 1350 },
  ]

  beforeEach(() => {
    trialBalanceMock.mockReset()
  })

  it('reads the bank at the end of the day from the balance after its last row, and both sides on that day', async () => {
    const { supabase, rpcCalls } = client({ rows: ROWS })
    bookedOn({ '2026-10-31': 1250 })
    const result = await checkBankBalance(supabase, COMPANY, account({ id: ID }), { on: '2026-10-31' })
    expect(result.refusal).toBeNull()
    expect(result.check).toMatchObject({
      as_of: '2026-10-31',
      fetched_at: null,
      balance_type: null,
      bank_balance: 1250,
      booked_balance: 1250,
      difference: 0,
    })
    expect(rpcCalls[0].args.p_through).toBe('2026-10-31')
  })

  it('carries the last day with rows over a quiet day, once the history reaches past it', async () => {
    const { supabase } = client({ rows: ROWS })
    bookedOn({ '2026-11-01': 1000 })
    const result = await checkBankBalance(supabase, COMPANY, account({ id: ID }), { on: '2026-11-01' })
    expect(result.check).toMatchObject({ as_of: '2026-11-01', bank_balance: 1250, booked_balance: 1000, difference: 250 })
  })

  it('has no balance for a day the history has not reached yet', async () => {
    // The feed stops on the 31st and the bank reported no later balance:
    // rows still to come could move the 2nd.
    const { supabase } = client({ rows: ROWS.filter((r) => r.date <= '2026-10-31') })
    const result = await checkBankBalance(supabase, COMPANY, account({ id: ID, balance: null }), { on: '2026-11-02' })
    expect(result).toEqual({ check: null, refusal: 'NO_BANK_BALANCE' })
    expect(trialBalanceMock).not.toHaveBeenCalled()
  })

  it('has no balance when the day\'s rows carry none, or before the first row', async () => {
    const withoutBalance = ROWS.map((r) => (r.date === '2026-10-31' && r.amount === 50 ? { ...r, balance_after: null } : r))
    const { supabase } = client({ rows: withoutBalance })
    expect(await checkBankBalance(supabase, COMPANY, account({ id: ID }), { on: '2026-10-31' })).toEqual({
      check: null,
      refusal: 'NO_BANK_BALANCE',
    })
    const { supabase: early } = client({ rows: ROWS })
    expect(await checkBankBalance(early, COMPANY, account({ id: ID }), { on: '2026-10-01' })).toEqual({
      check: null,
      refusal: 'NO_BANK_BALANCE',
    })
  })

  it('takes the balance the bank reported when it is for that very day, without reading rows', async () => {
    const { supabase, rowReads } = client({ rows: ROWS })
    bookedOn({ '2026-10-26': 1000 })
    const result = await checkBankBalance(supabase, COMPANY, account({ id: ID }), { on: '2026-10-26' })
    expect(result.check).toMatchObject({ as_of: '2026-10-26', fetched_at: '2026-10-26T10:00:00Z', bank_balance: 1000 })
    expect(rowReads.count).toBe(0)
  })
})

describe('dayEndBalance', () => {
  it('finds the end of the day whatever order the rows come in', () => {
    const rows = [
      { amount: 50, balance_after: 1250 },
      { amount: -300, balance_after: 1200 },
      { amount: 100, balance_after: 1500 },
    ]
    expect(dayEndBalance(rows)).toBe(1250)
    expect(dayEndBalance([...rows].reverse())).toBe(1250)
    expect(dayEndBalance([{ amount: '12.10', balance_after: '1000.10' }])).toBe(1000.1)
  })

  it('counts a row the feed delivered twice once', () => {
    expect(dayEndBalance([{ amount: 100, balance_after: 1100 }, { amount: 100, balance_after: 1100 }])).toBe(1100)
  })

  it('gives no balance when a row has none, when the chain breaks, or when the day nets to zero', () => {
    expect(dayEndBalance([])).toBeNull()
    expect(dayEndBalance([{ amount: 100, balance_after: 1100 }, { amount: 50, balance_after: null }])).toBeNull()
    // Two rows that start from nothing on the day: a row is missing between them.
    expect(dayEndBalance([{ amount: 100, balance_after: 1100 }, { amount: 50, balance_after: 2050 }])).toBeNull()
    // +100 and -100: either row could be the last.
    expect(dayEndBalance([{ amount: 100, balance_after: 1100 }, { amount: -100, balance_after: 1000 }])).toBeNull()
  })
})

describe('bankBalanceDay', () => {
  const at = '2026-10-26T10:00:00.123Z'
  const ref = (overrides: Record<string, unknown> = {}) => ({ date: '2026-10-23', type: 'CLBD', fetched_at: '2026-10-26T10:00:00.123+00:00', ...overrides })

  it('takes the bank\'s day and type when the reference came with this balance', () => {
    expect(bankBalanceDay(at, ref())).toEqual({ date: '2026-10-23', type: 'CLBD' })
    expect(bankBalanceDay(at, ref({ date: '2026-10-26', type: null }))).toEqual({ date: '2026-10-26', type: null })
  })

  it.each([
    ['no reference', null],
    ['a reference from an earlier balance', ref({ fetched_at: '2026-10-25T10:00:00+00:00' })],
    ['a day after the fetch', ref({ date: '2026-10-27' })],
    ['an impossible day', ref({ date: '2026-02-30' })],
    ['a timestamp for a day', ref({ date: '2026-10-23T00:00:00Z' })],
    ['no stamp', ref({ fetched_at: undefined })],
    ['a bare string', '2026-10-23'],
  ])('falls back to the Stockholm day of the fetch on %s', (_label, reference) => {
    expect(bankBalanceDay(at, reference)).toEqual({ date: '2026-10-26', type: null })
  })
})
