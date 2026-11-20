/**
 * pg-real tests for get_budget_line_sums (accounted#134, part 2): migration
 * 20261031121400_budget_line_sums.sql.
 *
 * The sum the grid's summed view and the reports' Budget columns read
 * instead of the lines: per account and month, over a window, filtered by
 * containment or by the exact tag, per code of one dimension, and never
 * across companies (the explicit filter for the service role, RLS for a
 * session).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

async function insertAccounts(companyId: string, userId: string, numbers: string[]): Promise<void> {
  for (const n of numbers) {
    const cls = Number(n[0])
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class,
          account_group, account_type, normal_balance, plan_type, is_system_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'full_bas', false)
       ON CONFLICT (company_id, account_number) DO NOTHING`,
      [userId, companyId, n, `Konto ${n}`, cls, n.slice(0, 2), cls === 3 ? 'revenue' : 'expense', cls === 3 ? 'credit' : 'debit'],
    )
  }
}

async function seedBudget() {
  const c = await seedCompany()
  await insertAccounts(c.companyId, c.userId, ['3010', '5010'])
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.budgets (company_id, user_id, fiscal_period_id, name, is_default)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [c.companyId, c.userId, c.fiscalPeriodId, `Budget ${randomUUID().slice(0, 8)}`],
  )
  const budgetId = rows[0]!.id
  const lines: Array<[string, string, Record<string, string>, number]> = [
    ['3010', '2026-01-01', { '6': 'H1' }, -1000],
    ['3010', '2026-01-01', { '6': 'H2' }, -2000],
    ['3010', '2026-02-01', { '6': 'H1' }, -1500],
    ['3010', '2026-01-01', {}, -100],
    ['5010', '2026-01-01', { '1': 'K1', '6': 'H1' }, 300],
    ['5010', '2026-03-01', {}, 400],
  ]
  for (const [account, month, dims, amount] of lines) {
    await getPool().query(
      `INSERT INTO public.budget_lines (budget_id, company_id, account_number, month, dimensions, amount)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [budgetId, c.companyId, account, month, JSON.stringify(dims), amount],
    )
  }
  return { ...c, budgetId }
}

interface SumRow {
  account_number: string
  month: string | null
  dim_code: string | null
  amount: string
}

async function sums(args: {
  companyId: string
  budgetId: string
  from?: string | null
  to?: string | null
  dimensions?: Record<string, string> | null
  exact?: boolean
  byMonth?: boolean
  groupDim?: string | null
}): Promise<Record<string, number>> {
  const { rows } = await getPool().query<SumRow>(
    `SELECT account_number, to_char(month, 'YYYY-MM') AS month, dim_code, amount
       FROM public.get_budget_line_sums($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      args.companyId,
      args.budgetId,
      args.from ?? null,
      args.to ?? null,
      args.dimensions ? JSON.stringify(args.dimensions) : null,
      args.exact ?? false,
      args.byMonth ?? true,
      args.groupDim ?? null,
    ],
  )
  return Object.fromEntries(rows.map((r) => [`${r.account_number}|${r.month ?? '*'}|${r.dim_code ?? '-'}`, Number(r.amount)]))
}

describe('get_budget_line_sums', () => {
  it('sums every tag per account and month, inside the window', async () => {
    const b = await seedBudget()
    expect(await sums(b)).toEqual({
      '3010|2026-01|-': -3100,
      '3010|2026-02|-': -1500,
      '5010|2026-01|-': 300,
      '5010|2026-03|-': 400,
    })
    expect(await sums({ ...b, from: '2026-02-01', to: '2026-03-01' })).toEqual({
      '3010|2026-02|-': -1500,
      '5010|2026-03|-': 400,
    })
  })

  it('filters by containment, or by the exact tag ({} exactly is the untagged lines)', async () => {
    const b = await seedBudget()
    // {6:H1} contains the line tagged {1:K1, 6:H1}, as journal line filters do.
    expect(await sums({ ...b, dimensions: { '6': 'H1' } })).toEqual({
      '3010|2026-01|-': -1000,
      '3010|2026-02|-': -1500,
      '5010|2026-01|-': 300,
    })
    expect(await sums({ ...b, dimensions: { '6': 'H1' }, exact: true })).toEqual({
      '3010|2026-01|-': -1000,
      '3010|2026-02|-': -1500,
    })
    expect(await sums({ ...b, dimensions: {}, exact: true })).toEqual({
      '3010|2026-01|-': -100,
      '5010|2026-03|-': 400,
    })
  })

  it('sums over the window per account, split per code of one dimension', async () => {
    const b = await seedBudget()
    expect(await sums({ ...b, byMonth: false, groupDim: '6' })).toEqual({
      '3010|*|H1': -2500,
      '3010|*|H2': -2000,
      '3010|*|-': -100,
      '5010|*|H1': 300,
      '5010|*|-': 400,
    })
  })

  it('answers nothing for another company\'s budget, under the service role and under RLS', async () => {
    const b = await seedBudget()
    const other = await seedBudget()
    expect(await sums({ ...b, companyId: other.companyId })).toEqual({})

    await setActiveCompany(other.userId, other.companyId)
    const seen = await withUserContext(other.userId, (client) =>
      client.query(`SELECT * FROM public.get_budget_line_sums($1, $2)`, [b.companyId, b.budgetId]),
    )
    expect(seen.rows).toHaveLength(0)

    await setActiveCompany(b.userId, b.companyId)
    const own = await withUserContext(b.userId, (client) =>
      client.query(`SELECT * FROM public.get_budget_line_sums($1, $2)`, [b.companyId, b.budgetId]),
    )
    expect(own.rows).toHaveLength(4)
  })

  it('is not callable by anon', async () => {
    const { rows } = await getPool().query<{ allowed: boolean }>(
      `SELECT has_function_privilege('anon', 'public.get_budget_line_sums(uuid, uuid, date, date, jsonb, boolean, boolean, text)', 'EXECUTE') AS allowed`,
    )
    expect(rows[0]!.allowed).toBe(false)
  })
})
