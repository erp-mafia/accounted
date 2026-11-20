/**
 * pg-real tests for budgets (accounted#134, part 1): migrations
 * 20261031121100_budgets.sql and
 * 20261031121200_budgets_redate_and_dimension_retention.sql.
 *
 * The tables: one default per year (a new default takes it from the old
 * one), a unique name per year, a budget stays in its year and company, an
 * archived budget is never the default and takes no amounts. A line is one
 * amount per resultatkonto, month and dimension tag, its month inside the
 * year, its account in the kontoplan, its tag well formed, never zero.
 * RLS and the writer-role trigger: a writing member saves, a viewer and an
 * outsider cannot. Every write lands in the audit log.
 *
 * The RPCs: upsert_budget_lines saves every cell or none and counts what
 * changed, its STABLE preview answers the same without writing;
 * get_account_month_actuals answers the same from the summaries and from
 * the lines, without the year-end chain.
 *
 * Existing paths: redate_fiscal_period (and a direct UPDATE of the dates)
 * refuses to leave a budget month outside the year, naming the budget; the
 * kontoplan's delete paths see budget lines (get_account_budget_line_counts)
 * while get_account_usage_counts stays journal lines only; a dimension value
 * or dimension a budget line uses cannot be deleted.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  seedCompany,
  setActiveCompany,
} from './fixtures'

const P_AND_L = ['3010', '4010', '5010', '6110', '8999']

async function insertAccounts(companyId: string, userId: string, numbers: string[] = P_AND_L): Promise<void> {
  for (const n of numbers) {
    const cls = Number(n[0])
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class,
          account_group, account_type, normal_balance, plan_type, is_system_account)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'full_bas', false)
       ON CONFLICT (company_id, account_number) DO NOTHING`,
      [userId, companyId, n, `Konto ${n}`, cls, n.slice(0, 2), cls === 1 ? 'asset' : cls === 3 ? 'revenue' : 'expense', cls === 3 ? 'credit' : 'debit'],
    )
  }
}

/** A company with a 2026 calendar year and a kontoplan of resultatkonton. */
async function seedBudgetCompany() {
  const seeded = await seedCompany()
  await insertAccounts(seeded.companyId, seeded.userId)
  return seeded
}

async function insertBudget(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  name?: string
  isDefault?: boolean
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.budgets (company_id, user_id, fiscal_period_id, name, is_default)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [params.companyId, params.userId, params.fiscalPeriodId, params.name ?? 'Budget 2026', params.isDefault ?? false],
  )
  return rows[0]!.id
}

async function insertLine(params: {
  budgetId: string
  companyId: string
  account?: string
  month?: string
  dimensions?: Record<string, string>
  amount?: number
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.budget_lines (budget_id, company_id, account_number, month, dimensions, amount)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      params.budgetId,
      params.companyId,
      params.account ?? '3010',
      params.month ?? '2026-01-01',
      JSON.stringify(params.dimensions ?? {}),
      params.amount ?? -1000,
    ],
  )
}

async function budgetDefaults(fiscalPeriodId: string): Promise<Record<string, boolean>> {
  const { rows } = await getPool().query<{ name: string; is_default: boolean }>(
    `SELECT name, is_default FROM public.budgets WHERE fiscal_period_id = $1`,
    [fiscalPeriodId],
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.is_default]))
}

async function lineAmounts(budgetId: string): Promise<Record<string, number>> {
  const { rows } = await getPool().query<{ k: string; amount: string }>(
    `SELECT account_number || '|' || to_char(month, 'YYYY-MM') || '|' || dimensions::text AS k, amount
       FROM public.budget_lines WHERE budget_id = $1`,
    [budgetId],
  )
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.amount)]))
}

interface SaveAnswer {
  ok: boolean
  code?: string
  inserted?: number
  updated?: number
  deleted?: number
  unchanged?: number
  [key: string]: unknown
}

async function save(budgetId: string, lines: unknown[]): Promise<SaveAnswer> {
  const { rows } = await getPool().query<{ r: SaveAnswer }>(
    `SELECT public.upsert_budget_lines($1, $2::jsonb) AS r`,
    [budgetId, JSON.stringify(lines)],
  )
  return rows[0]!.r
}

async function preview(budgetId: string, lines: unknown[]): Promise<SaveAnswer> {
  const { rows } = await getPool().query<{ r: SaveAnswer }>(
    `SELECT public.upsert_budget_lines_preview($1, $2::jsonb) AS r`,
    [budgetId, JSON.stringify(lines)],
  )
  return rows[0]!.r
}

describe('budgets', () => {
  it('keeps one default per year: a budget that becomes the default takes it from the other', async () => {
    const c = await seedBudgetCompany()
    await insertBudget({ ...c, name: 'Budget 2026', isDefault: true })
    await insertBudget({ ...c, name: 'Prognos 1', isDefault: true })
    expect(await budgetDefaults(c.fiscalPeriodId)).toEqual({ 'Budget 2026': false, 'Prognos 1': true })

    await getPool().query(`UPDATE public.budgets SET is_default = true WHERE fiscal_period_id = $1 AND name = 'Budget 2026'`, [
      c.fiscalPeriodId,
    ])
    expect(await budgetDefaults(c.fiscalPeriodId)).toEqual({ 'Budget 2026': true, 'Prognos 1': false })
  })

  it('refuses a name the year already has, case aside, and a name with surrounding blanks', async () => {
    const c = await seedBudgetCompany()
    await insertBudget({ ...c, name: 'Budget 2026' })
    await expect(insertBudget({ ...c, name: 'budget 2026' })).rejects.toMatchObject({ code: '23505' })
    await expect(insertBudget({ ...c, name: ' Prognos ' })).rejects.toMatchObject({ code: '23514' })
    // Another year may reuse the name.
    const next = await insertFiscalPeriod({ ...c, periodStart: '2027-01-01', periodEnd: '2027-12-31', name: '2027' })
    await expect(insertBudget({ ...c, fiscalPeriodId: next, name: 'Budget 2026' })).resolves.toBeTruthy()
  })

  it('never makes an archived budget the default', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget({ ...c, isDefault: true })
    await expect(
      getPool().query(`UPDATE public.budgets SET archived_at = now() WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
    await getPool().query(`UPDATE public.budgets SET archived_at = now(), is_default = false WHERE id = $1`, [id])
  })

  it('keeps a budget in its year, and only in a year of its own company', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    const next = await insertFiscalPeriod({ ...c, periodStart: '2027-01-01', periodEnd: '2027-12-31', name: '2027' })
    await expect(
      getPool().query(`UPDATE public.budgets SET fiscal_period_id = $1 WHERE id = $2`, [next, id]),
    ).rejects.toThrow(/kan inte flyttas/)

    const other = await seedBudgetCompany()
    await expect(insertBudget({ ...c, fiscalPeriodId: other.fiscalPeriodId })).rejects.toMatchObject({ code: '23503' })
  })

  it('writes the audit log for budgets and their lines', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId })
    const { rows } = await getPool().query<{ table_name: string; action: string }>(
      `SELECT table_name, action FROM public.audit_log
        WHERE company_id = $1 AND table_name IN ('budgets', 'budget_lines')
        ORDER BY table_name`,
      [c.companyId],
    )
    expect(rows.map((r) => r.table_name)).toEqual(['budget_lines', 'budgets'])
  })
})

describe('budget_lines', () => {
  it('takes a resultatkonto month inside the year, revenue negative', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId, account: '3010', month: '2026-12-01', amount: -12345.67 })
    expect(await lineAmounts(id)).toEqual({ '3010|2026-12|{}': -12345.67 })
  })

  it('refuses a month outside the year, a mid-month date, a balance sheet account, a bad tag and a zero', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget({ ...c, name: 'Budget 2026' })
    const base = { budgetId: id, companyId: c.companyId }
    await expect(insertLine({ ...base, month: '2027-01-01' })).rejects.toThrow(/utanför räkenskapsåret.*"Budget 2026"/)
    await expect(insertLine({ ...base, month: '2025-12-01' })).rejects.toThrow(/utanför räkenskapsåret/)
    await expect(insertLine({ ...base, month: '2026-03-15' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertLine({ ...base, account: '1930' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertLine({ ...base, dimensions: { x: 'P1' } })).rejects.toMatchObject({ code: '23514' })
    await expect(insertLine({ ...base, dimensions: { '6': 'a{b' } })).rejects.toMatchObject({ code: '23514' })
    await expect(insertLine({ ...base, amount: 0 })).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses an account outside the kontoplan', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await expect(insertLine({ budgetId: id, companyId: c.companyId, account: '3999' })).rejects.toMatchObject({ code: '23503' })
  })

  it('lets a first year that starts mid month own its start month', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, name: 'Nystart AB' })
    await insertCompanyMember({ companyId, userId })
    await insertAccounts(companyId, userId)
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId, periodStart: '2026-03-15', periodEnd: '2026-12-31' })
    const id = await insertBudget({ companyId, userId, fiscalPeriodId })
    await insertLine({ budgetId: id, companyId, month: '2026-03-01' })
    await expect(insertLine({ budgetId: id, companyId, month: '2026-02-01' })).rejects.toThrow(/utanför räkenskapsåret/)
  })

  it('takes no new or changed amounts on an archived budget', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId })
    await getPool().query(`UPDATE public.budgets SET archived_at = now() WHERE id = $1`, [id])
    await expect(insertLine({ budgetId: id, companyId: c.companyId, month: '2026-02-01' })).rejects.toThrow(/arkiverad/)
    await expect(
      getPool().query(`UPDATE public.budget_lines SET amount = -1 WHERE budget_id = $1`, [id]),
    ).rejects.toThrow(/arkiverad/)
  })

  it('is one cell per account, month and tag; the tag is part of the cell, key order aside', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    const base = { budgetId: id, companyId: c.companyId, account: '5010' }
    await insertLine(base)
    await insertLine({ ...base, dimensions: { '1': 'K1', '6': 'P1' } })
    await expect(insertLine(base)).rejects.toMatchObject({ code: '23505' })
    await expect(insertLine({ ...base, dimensions: { '6': 'P1', '1': 'K1' } })).rejects.toMatchObject({ code: '23505' })
  })

  it('goes with its budget, and with its account', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId, account: '3010' })
    await insertLine({ budgetId: id, companyId: c.companyId, account: '6110', amount: 50 })
    await getPool().query(`DELETE FROM public.chart_of_accounts WHERE company_id = $1 AND account_number = '6110'`, [c.companyId])
    expect(Object.keys(await lineAmounts(id))).toEqual(['3010|2026-01|{}'])
    await getPool().query(`DELETE FROM public.budgets WHERE id = $1`, [id])
    const { rows } = await getPool().query(`SELECT 1 FROM public.budget_lines WHERE budget_id = $1`, [id])
    expect(rows).toHaveLength(0)
  })
})

describe('budgets under RLS and the writer role', () => {
  it('a writing member saves; a viewer cannot write and an outsider sees nothing', async () => {
    const c = await seedBudgetCompany()
    await setActiveCompany(c.userId, c.companyId)
    const budgetId = await insertBudget(c)
    await insertLine({ budgetId, companyId: c.companyId })

    await withUserContext(c.userId, async (client) => {
      const res = await client.query(
        `INSERT INTO public.budgets (company_id, user_id, fiscal_period_id, name) VALUES ($1, $2, $3, 'Prognos') RETURNING id`,
        [c.companyId, c.userId, c.fiscalPeriodId],
      )
      expect(res.rows).toHaveLength(1)
      const saved = await client.query<{ r: SaveAnswer }>(`SELECT public.upsert_budget_lines($1, $2::jsonb) AS r`, [
        budgetId,
        JSON.stringify([{ account_number: '4010', month: '2026-02-01', amount: 200 }]),
      ])
      expect(saved.rows[0]!.r).toMatchObject({ ok: true, inserted: 1 })
    })

    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: c.companyId, userId: viewer, role: 'viewer' })
    await setActiveCompany(viewer, c.companyId)
    await withUserContext(viewer, async (client) => {
      const seen = await client.query(`SELECT id FROM public.budgets WHERE id = $1`, [budgetId])
      expect(seen.rows).toHaveLength(1)
      await client.query('SAVEPOINT viewer_insert')
      await expect(
        client.query(`INSERT INTO public.budgets (company_id, user_id, fiscal_period_id, name) VALUES ($1, $2, $3, 'Nej')`, [
          c.companyId,
          viewer,
          c.fiscalPeriodId,
        ]),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT viewer_insert')
      await client.query('SAVEPOINT viewer_save')
      await expect(
        client.query(`SELECT public.upsert_budget_lines($1, $2::jsonb)`, [
          budgetId,
          JSON.stringify([{ account_number: '4010', month: '2026-03-01', amount: 200 }]),
        ]),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT viewer_save')
      // A save that only removes a cell: RLS would filter the DELETE to
      // nothing, so the writer refuses up front instead of counting it.
      await expect(
        client.query(`SELECT public.upsert_budget_lines($1, $2::jsonb)`, [
          budgetId,
          JSON.stringify([{ account_number: '3010', month: '2026-01-01', amount: 0 }]),
        ]),
      ).rejects.toMatchObject({ code: '42501' })
    })
    expect(await lineAmounts(budgetId)).toMatchObject({ '3010|2026-01|{}': -1000 })

    const outsider = await seedBudgetCompany()
    await setActiveCompany(outsider.userId, outsider.companyId)
    await withUserContext(outsider.userId, async (client) => {
      const seen = await client.query(`SELECT id FROM public.budget_lines WHERE budget_id = $1`, [budgetId])
      expect(seen.rows).toHaveLength(0)
      const answer = await client.query<{ r: SaveAnswer }>(`SELECT public.upsert_budget_lines_preview($1, $2::jsonb) AS r`, [
        budgetId,
        JSON.stringify([{ account_number: '3010', month: '2026-01-01', amount: -1 }]),
      ])
      expect(answer.rows[0]!.r).toMatchObject({ ok: false, code: 'BUDGET_NOT_FOUND' })
    })
  })
})

describe('upsert_budget_lines', () => {
  it('saves the cells and counts what changed; 0 removes a cell', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    const first = await save(id, [
      { account_number: '3010', month: '2026-01-01', amount: -1000 },
      { account_number: '5010', month: '2026-01-01', amount: 300 },
      { account_number: '5010', month: '2026-01-01', dimensions: { '6': 'P1' }, amount: 100 },
    ])
    expect(first).toMatchObject({ ok: true, inserted: 3, updated: 0, deleted: 0, unchanged: 0 })

    const second = await save(id, [
      { account_number: '3010', month: '2026-01-01', amount: -1100 },
      { account_number: '5010', month: '2026-01-01', amount: 300 },
      { account_number: '5010', month: '2026-01-01', dimensions: { '6': 'P1' }, amount: 0 },
      { account_number: '6110', month: '2026-02-01', amount: 12.345 },
    ])
    expect(second).toMatchObject({ ok: true, inserted: 1, updated: 1, deleted: 1, unchanged: 1 })
    expect(await lineAmounts(id)).toEqual({
      '3010|2026-01|{}': -1100,
      '5010|2026-01|{}': 300,
      '6110|2026-02|{}': 12.35,
    })
  })

  it('the preview answers the same counts and writes nothing', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    const answer = await preview(id, [{ account_number: '3010', month: '2026-01-01', amount: -1000 }])
    expect(answer).toMatchObject({ ok: true, inserted: 1 })
    expect(await lineAmounts(id)).toEqual({})
    const { rows } = await getPool().query<{ provolatile: string }>(
      `SELECT provolatile FROM pg_proc WHERE oid = 'public.upsert_budget_lines_preview(uuid, jsonb)'::regprocedure`,
    )
    expect(rows[0]!.provolatile).toBe('s')
  })

  it('refuses the whole save when one cell is wrong, and names it', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    const good = { account_number: '3010', month: '2026-01-01', amount: -1000 }

    expect(await save(id, [good, { account_number: '3999', month: '2026-01-01', amount: 5 }])).toEqual({
      ok: false,
      code: 'BUDGET_ACCOUNT_NOT_FOUND',
      account_numbers: ['3999'],
    })
    expect(await save(id, [good, { account_number: '5010', month: '2027-01-01', amount: 5 }])).toMatchObject({
      ok: false,
      code: 'BUDGET_MONTH_OUTSIDE_YEAR',
      months: ['2027-01-01'],
      period_start: '2026-01-01',
      period_end: '2026-12-31',
    })
    expect(await save(id, [good, good])).toMatchObject({ ok: false, code: 'BUDGET_LINES_DUPLICATE' })
    expect(await save(id, [{ account_number: '3010', month: 'januari', amount: 1 }])).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    // What the table CHECKs refuse, the preview refuses first, so the dry
    // run and the save agree: a balance sheet account even when it is in
    // the kontoplan, NaN, and a malformed tag.
    await insertAccounts(c.companyId, c.userId, ['1930'])
    expect(await preview(id, [{ account_number: '1930', month: '2026-01-01', amount: 5 }])).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      account_numbers: ['1930'],
    })
    expect(await save(id, [{ account_number: '3010', month: '2026-01-01', amount: 'NaN' }])).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    expect(await save(id, [{ account_number: '3010', month: '2026-01-01', dimensions: { x: 'P1' }, amount: 5 }])).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    expect(await lineAmounts(id)).toEqual({})

    await getPool().query(`UPDATE public.budgets SET archived_at = now() WHERE id = $1`, [id])
    expect(await save(id, [good])).toMatchObject({ ok: false, code: 'BUDGET_ARCHIVED' })
    expect(await save(randomUUID(), [good])).toMatchObject({ ok: false, code: 'BUDGET_NOT_FOUND' })
  })
})

describe('get_account_month_actuals', () => {
  async function seedActuals() {
    const c = await seedBudgetCompany()
    const post = (voucherNumber: number, entryDate: string, lines: Parameters<typeof insertPostedJournalEntry>[0]['lines'], sourceType = 'manual') =>
      insertPostedJournalEntry({ ...c, voucherNumber, entryDate, sourceType, lines })
    await post(1, '2026-01-15', [
      { accountNumber: '1930', debitAmount: 10000, creditAmount: 0 },
      { accountNumber: '3010', debitAmount: 0, creditAmount: 10000 },
    ])
    await post(2, '2026-02-10', [
      { accountNumber: '5010', debitAmount: 3000, creditAmount: 0 },
      { accountNumber: '6110', debitAmount: 500, creditAmount: 0, dimensions: { '6': 'P1' } },
      { accountNumber: '6110', debitAmount: 200, creditAmount: 0, dimensions: { '6': 'P1', '1': 'K1' } },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 3700 },
    ])
    // The resultatavslut: left out, as the resultatrapport leaves it out.
    await post(
      3,
      '2026-12-31',
      [
        { accountNumber: '3010', debitAmount: 10000, creditAmount: 0 },
        { accountNumber: '8999', debitAmount: 0, creditAmount: 10000 },
      ],
      'year_end',
    )
    return c
  }

  async function actuals(companyId: string, periodId: string, from: string | null = null, to: string | null = null, dims: unknown = null) {
    const { rows } = await getPool().query<{ account_number: string; month: string; amount: string }>(
      `SELECT account_number, to_char(month, 'YYYY-MM') AS month, amount
         FROM public.get_account_month_actuals($1, $2, $3, $4, $5::jsonb)`,
      [companyId, periodId, from, to, dims === null ? null : JSON.stringify(dims)],
    )
    return rows.map((r) => `${r.account_number} ${r.month} ${Number(r.amount)}`)
  }

  it('reads the summaries and the lines alike, debit minus credit, without the year-end chain', async () => {
    const c = await seedActuals()
    await getPool().query(`INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [c.companyId])
    const expected = ['3010 2026-01 -10000', '5010 2026-02 3000', '6110 2026-02 700']
    expect(await actuals(c.companyId, c.fiscalPeriodId)).toEqual(expected)

    await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [c.companyId])
    expect(await actuals(c.companyId, c.fiscalPeriodId)).toEqual(expected)
  })

  it('filters one dimension value or several, and a window of whole months, on both paths', async () => {
    const c = await seedActuals()
    for (const ready of [true, false]) {
      if (ready) {
        await getPool().query(`INSERT INTO public.ledger_account_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [c.companyId])
      } else {
        await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [c.companyId])
      }
      expect(await actuals(c.companyId, c.fiscalPeriodId, null, null, { '6': 'P1' }), `ready ${ready}`).toEqual(['6110 2026-02 700'])
      expect(await actuals(c.companyId, c.fiscalPeriodId, null, null, { '6': 'P1', '1': 'K1' }), `ready ${ready}`).toEqual([
        '6110 2026-02 200',
      ])
      expect(await actuals(c.companyId, c.fiscalPeriodId, '2026-02-01', '2026-02-28'), `ready ${ready}`).toEqual([
        '5010 2026-02 3000',
        '6110 2026-02 700',
      ])
    }
  })

  it('answers nothing for a year of another company', async () => {
    const c = await seedActuals()
    const other = await seedBudgetCompany()
    expect(await actuals(other.companyId, c.fiscalPeriodId)).toEqual([])
  })
})

describe('redate_fiscal_period and budgets', () => {
  const REDATE = `SELECT public.redate_fiscal_period($1::uuid, $2::uuid, $3::date, $4::date, NULL, $5::boolean, $6::uuid) AS result`

  it('refuses a re-date that leaves a budget month outside the year, naming the budget, in the dry run too', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget({ ...c, name: 'Budget 2026' })
    await insertLine({ budgetId: id, companyId: c.companyId, month: '2026-12-01' })

    for (const dryRun of [true, false]) {
      const { rows } = await getPool().query<{ result: { ok: boolean; code: string; blockers: { code: string; message_sv: string }[] } }>(
        REDATE,
        [c.companyId, c.fiscalPeriodId, null, '2026-11-30', dryRun, c.userId],
      )
      const result = rows[0]!.result
      expect(result).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_DATES_BLOCKED' })
      const blocker = result.blockers.find((b) => b.code === 'budget_months_outside')
      expect(blocker?.message_sv).toContain('"Budget 2026"')
    }
    const { rows } = await getPool().query(`SELECT period_end::text FROM public.fiscal_periods WHERE id = $1`, [c.fiscalPeriodId])
    expect(rows[0].period_end).toBe('2026-12-31')
  })

  it('moves the year when every budget month stays inside it', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId, month: '2026-11-01' })
    const { rows } = await getPool().query(REDATE, [c.companyId, c.fiscalPeriodId, null, '2026-11-30', false, c.userId])
    expect(rows[0].result).toMatchObject({ ok: true, changed: true })
  })

  it('refuses a direct UPDATE of the dates too', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget({ ...c, name: 'Budget 2026' })
    await insertLine({ budgetId: id, companyId: c.companyId, month: '2026-12-01' })
    await expect(
      getPool().query(`UPDATE public.fiscal_periods SET period_end = '2026-11-30' WHERE id = $1`, [c.fiscalPeriodId]),
    ).rejects.toThrow(/Budget "Budget 2026" har belopp för månader utanför/)
  })
})

describe('the kontoplan sees budget lines', () => {
  it('counts budget lines per account apart from the journal usage count', async () => {
    const c = await seedBudgetCompany()
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId, account: '4010', month: '2026-01-01', amount: 10 })
    await insertLine({ budgetId: id, companyId: c.companyId, account: '4010', month: '2026-02-01', amount: 10 })

    const budget = await getPool().query<{ account_number: string; budget_line_count: string }>(
      `SELECT * FROM public.get_account_budget_line_counts($1)`,
      [c.companyId],
    )
    expect(budget.rows.map((r) => [r.account_number, Number(r.budget_line_count)])).toEqual([['4010', 2]])
    const usage = await getPool().query(`SELECT * FROM public.get_account_usage_counts($1) WHERE account_number = '4010'`, [c.companyId])
    expect(usage.rows).toHaveLength(0)
  })
})

describe('dimension retention covers budget lines', () => {
  it('refuses deleting a value or a dimension a budget line uses, naming the budget; an unused value goes', async () => {
    const c = await seedBudgetCompany()
    await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [c.companyId])
    const project = await getPool().query<{ id: string }>(
      `SELECT id FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = 6`,
      [c.companyId],
    )
    const region = await getPool().query<{ id: string }>(
      `INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
       VALUES ($1, 20, 'Region', false, false, 30) RETURNING id`,
      [c.companyId],
    )
    for (const [dimensionId, code] of [
      [project.rows[0]!.id, 'P1'],
      [project.rows[0]!.id, 'P2'],
      [region.rows[0]!.id, 'R1'],
    ] as const) {
      await getPool().query(`INSERT INTO public.dimension_values (company_id, dimension_id, code, name) VALUES ($1, $2, $3, $3)`, [
        c.companyId,
        dimensionId,
        code,
      ])
    }
    const id = await insertBudget({ ...c, name: 'Budget 2026' })
    await insertLine({ budgetId: id, companyId: c.companyId, dimensions: { '6': 'P1', '20': 'R1' } })

    await expect(
      getPool().query(`DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P1'`, [c.companyId]),
    ).rejects.toThrow(/Värdet "P1" används i budgeten "Budget 2026"/)
    await expect(
      getPool().query(`DELETE FROM public.dimensions WHERE id = $1`, [region.rows[0]!.id]),
    ).rejects.toThrow(/Dimensionen 20 \(Region\) används i budgeten "Budget 2026"/)
    await getPool().query(`DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P2'`, [c.companyId])
  })

  it('stands aside inside the destructive window of a reset or an undo, and the line keeps its tag', async () => {
    const c = await seedBudgetCompany()
    await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [c.companyId])
    const project = await getPool().query<{ id: string }>(
      `SELECT id FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = 6`,
      [c.companyId],
    )
    await getPool().query(`INSERT INTO public.dimension_values (company_id, dimension_id, code, name) VALUES ($1, $2, 'P1', 'P1')`, [
      c.companyId,
      project.rows[0]!.id,
    ])
    const id = await insertBudget(c)
    await insertLine({ budgetId: id, companyId: c.companyId, dimensions: { '6': 'P1' } })

    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await client.query(`DELETE FROM public.dimension_values WHERE company_id = $1 AND code = 'P1'`, [c.companyId])
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    expect(Object.keys(await lineAmounts(id))).toEqual(['3010|2026-01|{"6": "P1"}'])
  })
})
