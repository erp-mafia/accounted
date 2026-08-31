import {
  getPool,
  seedBaseCompany,
  seedPostedEntry,
  type TrialEnv,
} from './ledger-env'

// Seed and assertion programs for the ledger-agent suite, keyed by the names
// task JSON refers to. Assertions read the END STATE of the books: the
// transcript is never graded.

export interface AssertionResult {
  name: string
  pass: boolean
  detail: string
}

async function netBalance(env: TrialEnv, account: string): Promise<number> {
  const res = await getPool().query(
    `SELECT COALESCE(ROUND(SUM(l.debit_amount - l.credit_amount)::numeric, 2), 0)::float8 AS net
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted' AND l.account_number = $2`,
    [env.companyId, account],
  )
  return res.rows[0].net as number
}

async function netBalanceLike(env: TrialEnv, pattern: string): Promise<number> {
  const res = await getPool().query(
    `SELECT COALESCE(ROUND(SUM(l.debit_amount - l.credit_amount)::numeric, 2), 0)::float8 AS net
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND e.status = 'posted' AND l.account_number ~ $2`,
    [env.companyId, pattern],
  )
  return res.rows[0].net as number
}

async function postedEntryCount(env: TrialEnv): Promise<number> {
  const res = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM public.journal_entries
      WHERE company_id = $1 AND status = 'posted'`,
    [env.companyId],
  )
  return res.rows[0].n as number
}

function assertEq(name: string, got: number, want: number): AssertionResult {
  const pass = Math.abs(got - want) < 0.005
  return { name, pass, detail: `expected ${want}, got ${got}` }
}

// ---------------------------------------------------------------------------

export const SEEDS: Record<string, () => Promise<TrialEnv>> = {
  // Empty VAT-registered AB with an open 2026 fiscal year.
  base_company: async () => seedBaseCompany(),

  // Company where the Fortnox software licence was wrongly booked on 6071
  // (representation) as voucher A1.
  wrong_account_posted: async () => {
    const env = await seedBaseCompany()
    env.seededEntries.wrong = await seedPostedEntry(
      env,
      '2026-06-05',
      'Fortnox licens juni',
      [
        { account: '6071', debit: 5625, credit: 0 },
        { account: '1930', debit: 0, credit: 5625 },
      ],
    )
    return env
  },

  // Company with Q2 activity leaving VAT balances to settle: one sales
  // invoice and one expense.
  q2_vat_activity: async () => {
    const env = await seedBaseCompany()
    env.seededEntries.sale = await seedPostedEntry(env, '2026-05-12', 'Kundfaktura 1001', [
      { account: '1510', debit: 12500, credit: 0 },
      { account: '3001', debit: 0, credit: 10000 },
      { account: '2611', debit: 0, credit: 2500 },
    ])
    env.seededEntries.expense = await seedPostedEntry(
      env,
      '2026-05-20',
      'Kontorsmaterial',
      [
        { account: '6110', debit: 800, credit: 0 },
        { account: '2641', debit: 200, credit: 0 },
        { account: '1930', debit: 0, credit: 1000 },
      ],
    )
    return env
  },
}

export const ASSERTIONS: Record<string, (env: TrialEnv) => Promise<AssertionResult[]>> = {
  // L1: EU reverse charge booking. End state must carry both sides of the
  // reverse charge (2614 output, 2645 input) and the bank credit, with the
  // cost on a class 4-6 expense account.
  reverse_charge_booked: async (env) => {
    const out: AssertionResult[] = []
    out.push(assertEq('2614 credit balance (utgaende moms omvand betalningsskyldighet)', await netBalance(env, '2614'), -2812.5))
    out.push(assertEq('2645 debit balance (beraknad ingaende moms)', await netBalance(env, '2645'), 2812.5))
    out.push(assertEq('1930 credited with the payment', await netBalance(env, '1930'), -11250))
    out.push(assertEq('cost on a class 4-6 account', await netBalanceLike(env, '^[456]'), 11250))
    out.push(assertEq('exactly one voucher', await postedEntryCount(env), 1))
    return out
  },

  // L2: correction of a posted entry. The original must be untouched
  // (immutability), the wrong account must net to zero via a reversal, and
  // the cost must land on a software/IT account.
  storno_correction: async (env) => {
    const out: AssertionResult[] = []
    const original = await getPool().query(
      `SELECT l.account_number, l.debit_amount::float8 AS d, l.credit_amount::float8 AS c
         FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = $1
        ORDER BY l.sort_order`,
      [env.seededEntries.wrong],
    )
    const rows = original.rows as { account_number: string; d: number; c: number }[]
    const untouched =
      rows.length === 2 &&
      rows.some((r) => r.account_number === '6071' && r.d === 5625 && r.c === 0) &&
      rows.some((r) => r.account_number === '1930' && r.c === 5625 && r.d === 0)
    out.push({
      name: 'original voucher unchanged (BFL 5 kap. 5)',
      pass: untouched,
      detail: JSON.stringify(rows),
    })
    const status = await getPool().query(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [env.seededEntries.wrong],
    )
    out.push({
      name: 'original voucher still exists',
      pass: ['posted', 'reversed'].includes(status.rows[0]?.status as string),
      detail: `status=${status.rows[0]?.status}`,
    })
    out.push(assertEq('6071 nets to zero', await netBalance(env, '6071'), 0))
    out.push(
      assertEq(
        'cost on software/IT account (5420 or 6540)',
        (await netBalance(env, '5420')) + (await netBalance(env, '6540')),
        5625,
      ),
    )
    out.push(assertEq('1930 unchanged in total', await netBalance(env, '1930'), -5625))
    return out
  },

  // L3: VAT settlement entry for Q2. 2611 and 2641 must be cleared into 2650.
  vat_settled: async (env) => {
    const out: AssertionResult[] = []
    out.push(assertEq('2611 cleared', await netBalance(env, '2611'), 0))
    out.push(assertEq('2641 cleared', await netBalance(env, '2641'), 0))
    out.push(assertEq('2650 carries the net VAT debt', await netBalance(env, '2650'), -2300))
    out.push(assertEq('sales revenue untouched', await netBalance(env, '3001'), -10000))
    return out
  },
}
