import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool, getClient, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember, insertPostedJournalEntry } from './fixtures'

// pg-real coverage for 20260906210300_utlagg_via_lon (+ 20260906210301):
//   - the expense_reimbursement item type on salary_line_items
//   - salary_line_items.source_expense_claim_id: tenant-scoped FK, cascade on
//     claim delete, one payslip line per claim
//   - settle_expense_claims_via_salary_run: the payroll-side twin of
//     create_expense_payout_batch (same batch table, same status flip, no
//     verifikat of its own), idempotent, refuses anything not open

type SettleResult = {
  ok: boolean
  code?: string
  details?: Record<string, unknown>
  claim_count?: number
  already_settled?: number
  total_sek?: string | number
  journal_entry_id?: string
  batches?: Array<{ batch_id: string; employee_id: string; total_sek: string | number; claim_count: number }>
}

async function insertEmployee(companyId: string, userId: string, first = 'Anna'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.employees
       (company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_type, employment_start, employment_degree, salary_type)
     VALUES ($1, $2, $3, 'Anställd', $4, $5, 'employee', '2026-01-01', 100, 'monthly')
     RETURNING id`,
    [companyId, userId, first, `19900101${String(Math.floor(1000 + Math.random() * 9000))}`, '1234'],
  )
  return rows[0].id
}

async function insertClaim(
  companyId: string,
  userId: string,
  employeeId: string | null,
  amountSek: number,
  opts: { liability?: string; claimant?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.expense_claims
       (id, company_id, user_id, employee_id, claimant_name, description, expense_date,
        amount_sek, vat_sek, expense_account, liability_account, status)
     VALUES ($1, $2, $3, $4, $5, 'Kabel', '2026-06-10', $6, 0, '5410', $7, 'registered')`,
    [id, companyId, userId, employeeId, opts.claimant ?? 'Anna Anställd', amountSek, opts.liability ?? '2820'],
  )
  return id
}

/** One run per period and company (idx_salary_runs_period_unique): pass a month for a second run. */
async function insertRun(companyId: string, userId: string, status = 'draft', month = 6): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, $4, $5, $6)`,
    [id, companyId, userId, month, `2026-${String(month).padStart(2, '0')}-25`, status],
  )
  return id
}

async function insertSre(runId: string, employeeId: string, companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_run_employees
       (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 30000, 'monthly')
     RETURNING id`,
    [runId, employeeId, companyId],
  )
  return rows[0].id
}

async function insertLine(
  sreId: string,
  companyId: string,
  opts: { claimId?: string | null; amount: number; itemType?: string; account?: string },
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, account_number, source_expense_claim_id)
     VALUES ($1, $2, $3, 'Utlägg: Kabel', $4, false, false, false, $5, $6)
     RETURNING id`,
    [sreId, companyId, opts.itemType ?? 'expense_reimbursement', opts.amount, opts.account ?? '2820', opts.claimId ?? null],
  )
  return rows[0].id
}

/** Post the salary verifikat (2820 D / 1930 K) and flip the run to booked. */
async function bookRun(args: {
  runId: string
  companyId: string
  userId: string
  fiscalPeriodId: string
  amount: number
}): Promise<string> {
  const jeId = await insertPostedJournalEntry({
    userId: args.userId,
    companyId: args.companyId,
    fiscalPeriodId: args.fiscalPeriodId,
    entryDate: '2026-06-25',
    description: 'Lön 2026-06',
    voucherSeries: 'L',
    voucherNumber: 1,
    sourceType: 'salary_payment',
    sourceId: args.runId,
    lines: [
      { accountNumber: '2820', debitAmount: args.amount, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: args.amount },
    ],
  })
  await getPool().query(
    `UPDATE public.salary_runs SET status = 'booked', salary_entry_id = $2 WHERE id = $1`,
    [args.runId, jeId],
  )
  return jeId
}

async function settle(client: PoolClient, companyId: string, runId: string): Promise<SettleResult> {
  const { rows } = await client.query<{ r: SettleResult }>(
    `SELECT public.settle_expense_claims_via_salary_run($1, $2, NULL) AS r`,
    [companyId, runId],
  )
  return rows[0].r
}

/** Like withUserContext but COMMITs, so a later call can observe the result. */
async function asUser<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function claimState(claimIds: string[]) {
  const { rows } = await getPool().query<{ id: string; status: string; payout_batch_id: string | null }>(
    `SELECT id, status, payout_batch_id FROM public.expense_claims WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [claimIds],
  )
  return rows
}

async function ledgerCounts(companyId: string) {
  const { rows } = await getPool().query<{ batches: string; payouts: string }>(
    `SELECT
       (SELECT count(*) FROM public.expense_payout_batches WHERE company_id = $1)::text AS batches,
       (SELECT count(*) FROM public.journal_entries WHERE company_id = $1 AND source_type = 'expense_payout')::text AS payouts`,
    [companyId],
  )
  return { batches: Number(rows[0].batches), payouts: Number(rows[0].payouts) }
}

describe('salary_line_items.source_expense_claim_id', () => {
  it('accepts expense_reimbursement lines and keeps a claim on one payslip line at a time', async () => {
    const { userId, companyId } = await seedCompany()
    const employeeId = await insertEmployee(companyId, userId)
    const claimId = await insertClaim(companyId, userId, employeeId, 250.5)
    const runA = await insertRun(companyId, userId)
    const runB = await insertRun(companyId, userId, 'draft', 7)
    const sreA = await insertSre(runA, employeeId, companyId)
    const sreB = await insertSre(runB, employeeId, companyId)

    await insertLine(sreA, companyId, { claimId, amount: 250.5 })
    await expect(insertLine(sreB, companyId, { claimId, amount: 250.5 })).rejects.toMatchObject({ code: '23505' })
    // The unlinked form of the type is still fine (a manual tax-free line).
    await expect(insertLine(sreB, companyId, { amount: 100 })).resolves.toBeTruthy()
  })

  it('binds the link to the line\'s own company (composite FK)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const employeeA = await insertEmployee(a.companyId, a.userId)
    const employeeB = await insertEmployee(b.companyId, b.userId)
    const foreignClaim = await insertClaim(b.companyId, b.userId, employeeB, 100)
    const runA = await insertRun(a.companyId, a.userId)
    const sreA = await insertSre(runA, employeeA, a.companyId)

    await expect(insertLine(sreA, a.companyId, { claimId: foreignClaim, amount: 100 })).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('drops the payslip line when its claim is deleted (cascade)', async () => {
    const { userId, companyId } = await seedCompany()
    const employeeId = await insertEmployee(companyId, userId)
    const claimId = await insertClaim(companyId, userId, employeeId, 100)
    const runId = await insertRun(companyId, userId)
    const sreId = await insertSre(runId, employeeId, companyId)
    const lineId = await insertLine(sreId, companyId, { claimId, amount: 100 })

    await getPool().query(`DELETE FROM public.expense_claims WHERE id = $1`, [claimId])
    const { rows } = await getPool().query(`SELECT id FROM public.salary_line_items WHERE id = $1`, [lineId])
    expect(rows).toHaveLength(0)
  })
})

describe('settle_expense_claims_via_salary_run', () => {
  it('marks the claims paid with one batch per person pointing at the salary verifikat, no second verifikat', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const anna = await insertEmployee(companyId, userId, 'Anna')
    const bo = await insertEmployee(companyId, userId, 'Bo')
    const a1 = await insertClaim(companyId, userId, anna, 250.5)
    const a2 = await insertClaim(companyId, userId, anna, 1196)
    const b1 = await insertClaim(companyId, userId, bo, 80, { claimant: 'Bo Anställd' })
    const runId = await insertRun(companyId, userId, 'paid')
    const sreAnna = await insertSre(runId, anna, companyId)
    const sreBo = await insertSre(runId, bo, companyId)
    await insertLine(sreAnna, companyId, { claimId: a1, amount: 250.5 })
    await insertLine(sreAnna, companyId, { claimId: a2, amount: 1196 })
    await insertLine(sreBo, companyId, { claimId: b1, amount: 80 })
    const jeId = await bookRun({ runId, companyId, userId, fiscalPeriodId, amount: 1526.5 })

    const r = await asUser(userId, (c) => settle(c, companyId, runId))

    expect(r.ok).toBe(true)
    expect(r.claim_count).toBe(3)
    expect(r.already_settled).toBe(0)
    expect(Number(r.total_sek)).toBe(1526.5)
    expect(r.journal_entry_id).toBe(jeId)
    expect(r.batches).toHaveLength(2)

    const { rows: batches } = await getPool().query<{
      employee_id: string
      claimant_name: string
      payout_date: string
      cash_account: string
      liability_account: string
      total_sek: string
      journal_entry_id: string
      notes: string
    }>(
      `SELECT b.employee_id, b.claimant_name, b.payout_date::text, b.cash_account, b.liability_account,
              b.total_sek::text, b.journal_entry_id, b.notes
       FROM public.expense_payout_batches b WHERE b.company_id = $1 ORDER BY b.total_sek`,
      [companyId],
    )
    expect(batches).toEqual([
      {
        employee_id: bo,
        claimant_name: 'Bo Anställd',
        payout_date: '2026-06-25',
        cash_account: '1930',
        liability_account: '2820',
        total_sek: '80.00',
        journal_entry_id: jeId,
        notes: 'Utbetalt via lön 2026-06',
      },
      {
        employee_id: anna,
        claimant_name: 'Anna Anställd',
        payout_date: '2026-06-25',
        cash_account: '1930',
        liability_account: '2820',
        total_sek: '1446.50',
        journal_entry_id: jeId,
        notes: 'Utbetalt via lön 2026-06',
      },
    ])

    const claims = await claimState([a1, a2, b1])
    expect(claims.map((c) => c.status)).toEqual(['paid', 'paid', 'paid'])
    const annaBatch = batches[1]
    const { rows: annaClaims } = await getPool().query<{ payout_batch_id: string; bid: string }>(
      `SELECT ec.payout_batch_id, b.id AS bid FROM public.expense_claims ec
       JOIN public.expense_payout_batches b ON b.id = ec.payout_batch_id
       WHERE ec.id = ANY($1::uuid[]) AND b.employee_id = $2`,
      [[a1, a2], anna],
    )
    expect(annaClaims).toHaveLength(2)
    expect(annaBatch.employee_id).toBe(anna)

    // The salary verifikat IS the payout: nothing else was posted.
    expect(await ledgerCounts(companyId)).toEqual({ batches: 2, payouts: 0 })
  })

  it('is idempotent: a retry counts the claims as already settled and adds no batch', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const anna = await insertEmployee(companyId, userId)
    const a1 = await insertClaim(companyId, userId, anna, 100)
    const runId = await insertRun(companyId, userId, 'paid')
    const sre = await insertSre(runId, anna, companyId)
    await insertLine(sre, companyId, { claimId: a1, amount: 100 })
    await bookRun({ runId, companyId, userId, fiscalPeriodId, amount: 100 })

    const first = await asUser(userId, (c) => settle(c, companyId, runId))
    expect(first).toMatchObject({ ok: true, claim_count: 1, already_settled: 0 })
    const second = await asUser(userId, (c) => settle(c, companyId, runId))
    expect(second).toMatchObject({ ok: true, claim_count: 0, already_settled: 1 })
    expect(second.batches).toEqual([])
    expect(await ledgerCounts(companyId)).toEqual({ batches: 1, payouts: 0 })
  })

  it('refuses a run that is not booked, a claim paid elsewhere, a drifted amount, and non-writers', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const anna = await insertEmployee(companyId, userId)
    const a1 = await insertClaim(companyId, userId, anna, 100)
    const a2 = await insertClaim(companyId, userId, anna, 200)
    const runId = await insertRun(companyId, userId, 'paid')
    const sre = await insertSre(runId, anna, companyId)
    await insertLine(sre, companyId, { claimId: a1, amount: 100 })
    const line2 = await insertLine(sre, companyId, { claimId: a2, amount: 200 })

    // Not booked yet: nothing to point the batch at.
    const notBooked = await withUserContext(userId, (c) => settle(c, companyId, runId))
    expect(notBooked).toMatchObject({ ok: false, code: 'SALARY_RUN_NOT_BOOKED', details: { status: 'paid' } })

    await bookRun({ runId, companyId, userId, fiscalPeriodId, amount: 300 })

    // Viewer and stranger: FORBIDDEN, ledger untouched.
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const stranger = await insertAuthUser()
    for (const uid of [viewer, stranger]) {
      const r = await withUserContext(uid, (c) => settle(c, companyId, runId))
      expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(await ledgerCounts(companyId)).toEqual({ batches: 0, payouts: 0 })

    // Amount drift between line and claim: refused before any write.
    await getPool().query(`UPDATE public.salary_line_items SET amount = 199 WHERE id = $1`, [line2])
    const drift = await withUserContext(userId, (c) => settle(c, companyId, runId))
    expect(drift).toMatchObject({ ok: false, code: 'CLAIM_AMOUNT_MISMATCH', details: { claim_id: a2 } })
    await getPool().query(`UPDATE public.salary_line_items SET amount = 200 WHERE id = $1`, [line2])

    // a2 paid by some other batch in the meantime: the salary verifikat
    // already carries its 2820 debit, so this is a refusal, not a skip.
    const otherBatch = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_payout_batches
         (id, company_id, user_id, employee_id, claimant_name, payout_date, cash_account, liability_account, total_sek)
       VALUES ($1, $2, $3, $4, 'Anna Anställd', '2026-06-20', '1930', '2820', 200)`,
      [otherBatch, companyId, userId, anna],
    )
    await getPool().query(
      `UPDATE public.expense_claims SET status = 'paid', payout_batch_id = $2 WHERE id = $1`,
      [a2, otherBatch],
    )
    const notOpen = await withUserContext(userId, (c) => settle(c, companyId, runId))
    expect(notOpen).toMatchObject({ ok: false, code: 'CLAIM_NOT_OPEN', details: { claim_id: a2 } })
    expect(await claimState([a1])).toEqual([{ id: a1, status: 'registered', payout_batch_id: null }])
    expect(await ledgerCounts(companyId)).toEqual({ batches: 1, payouts: 0 })
  })

  it('settles nothing and answers ok for a booked run without utlägg lines', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const anna = await insertEmployee(companyId, userId)
    const runId = await insertRun(companyId, userId, 'paid')
    await insertSre(runId, anna, companyId)
    await bookRun({ runId, companyId, userId, fiscalPeriodId, amount: 100 })

    const r = await withUserContext(userId, (c) => settle(c, companyId, runId))
    expect(r).toMatchObject({ ok: true, claim_count: 0, already_settled: 0 })
    expect(r.batches).toEqual([])
  })
})
