import { beforeEach, describe, expect, it, vi } from 'vitest'

const trialBalanceMock = vi.fn()
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: (...args: unknown[]) => trialBalanceMock(...args),
}))

import { checkBankBalance, type BankBalanceCheckAccount } from '../bank-balance-check'

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

/**
 * A client whose reads answer by table: the company's ledger currency, its
 * fiscal periods and get_bank_balance_facts. Records the RPC arguments.
 */
function client(options: { ledgerCurrency?: string | null; periods?: typeof PERIODS; facts?: Facts; factsError?: string } = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const answer = (data: unknown, error: unknown = null) => Promise.resolve({ data, error })
  const supabase = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          table === 'companies'
            ? answer({ ledger_currency: options.ledgerCurrency === undefined ? 'SEK' : options.ledgerCurrency })
            : answer(null),
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return (table === 'fiscal_periods' ? answer(options.periods ?? PERIODS) : answer([])).then(resolve, reject)
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
  return { supabase: supabase as never, rpcCalls }
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
