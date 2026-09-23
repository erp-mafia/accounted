import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import type { PoolClient } from 'pg'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20260920190100_salary_line_items_source_benefit_no_action
// (#2801). salary_line_items.source_benefit_id was ON DELETE SET NULL, so
// deleting a benefit that a payslip line derives from silently turned that
// line into an apparent manual one: step 8d of lib/salary/run-calculation.ts
// replaces derived lines by that back-link, so the line was never removed
// again and the employee stayed taxed on a removed förmån. The application
// guarded it with a count-then-delete, which a recalculation can slip between.
// The FK is now NO ACTION, the same action the recurring-lines back-link has
// carried since 20260902140000, so Postgres itself refuses the delete.

interface Seed {
  userId: string
  companyId: string
  employeeId: string
  benefitId: string
  sreId: string
}

async function seed(status: 'draft' | 'booked' = 'draft'): Promise<Seed> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  const benefitId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employee_benefits
       (id, employee_id, company_id, user_id, benefit_type, description, monthly_value, valid_from)
     VALUES ($1, $2, $3, $4, 'car', 'Bilförmån', 3200, '2026-01-01')`,
    [benefitId, employeeId, companyId, userId],
  )
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 8, '2026-08-25', $4)`,
    [runId, companyId, userId, status],
  )
  const sreId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
     VALUES ($1, $2, $3, $4, 'monthly', 35000, 100)`,
    [sreId, runId, employeeId, companyId],
  )
  return { userId, companyId, employeeId, benefitId, sreId }
}

// The row step 8d writes: a taxable, avgift-bearing benefit line carrying the
// back-link. Takes a client so a test can hold it inside an open transaction.
async function deriveLine(
  client: { query: PoolClient['query'] },
  s: Pick<Seed, 'companyId' | 'sreId' | 'benefitId'>,
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO public.salary_line_items
       (id, salary_run_employee_id, company_id, item_type, description, quantity, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction, source_benefit_id)
     VALUES ($1, $2, $3, 'benefit_car', 'Bilförmån', 1, 3200, true, true, false, false, false, $4)`,
    [id, s.sreId, s.companyId, s.benefitId],
  )
  return id
}

/** Lines that read as a manual benefit line: the #2801 orphan shape. */
async function orphanCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM public.salary_line_items
      WHERE company_id = $1 AND item_type LIKE 'benefit%' AND source_benefit_id IS NULL`,
    [companyId],
  )
  return Number(rows[0].n)
}

/** Resolve once `pid` is parked on a heavyweight lock: proof it is really blocked, not merely slow. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await getPool().query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    )
    if (rows[0]?.wait_event_type === 'Lock') return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`backend ${pid} never blocked on a lock`)
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
  return rows[0].pid
}

describe('salary_line_items.source_benefit_id foreign key', () => {
  it('is NO ACTION, matching the recurring-lines back-link', async () => {
    const { rows } = await getPool().query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
        WHERE conrelid = 'public.salary_line_items'::regclass
          AND conname IN ('salary_line_items_source_benefit_id_fkey',
                          'salary_line_items_source_recurring_line_id_fkey')
        ORDER BY conname`,
    )
    // 'a' = NO ACTION. 'n' (SET NULL) is the action that orphaned lines.
    expect(rows).toEqual([
      { conname: 'salary_line_items_source_benefit_id_fkey', confdeltype: 'a' },
      { conname: 'salary_line_items_source_recurring_line_id_fkey', confdeltype: 'a' },
    ])
  })

  it('refuses to delete a benefit a payslip line derives from, and keeps the link', async () => {
    const s = await seed()
    const lineId = await deriveLine(getPool(), s)

    await expect(
      getPool().query(`DELETE FROM public.employee_benefits WHERE id = $1`, [s.benefitId]),
    ).rejects.toMatchObject({ code: '23503' })

    const { rows } = await getPool().query<{ source_benefit_id: string | null }>(
      `SELECT source_benefit_id FROM public.salary_line_items WHERE id = $1`,
      [lineId],
    )
    expect(rows[0].source_benefit_id).toBe(s.benefitId)
    expect(await orphanCount(s.companyId)).toBe(0)

    // Deactivation, the module's fallback on 23503, still works.
    const off = await getPool().query(
      `UPDATE public.employee_benefits SET is_active = false WHERE id = $1`,
      [s.benefitId],
    )
    expect(off.rowCount).toBe(1)
  })

  it('never rewrites a line on a booked run when its benefit is deleted', async () => {
    // No immutability trigger guards salary_line_items, so under SET NULL a
    // benefit delete silently mutated a line beneath a booked verifikat.
    const s = await seed('booked')
    const lineId = await deriveLine(getPool(), s)

    await expect(
      getPool().query(`DELETE FROM public.employee_benefits WHERE id = $1`, [s.benefitId]),
    ).rejects.toMatchObject({ code: '23503' })

    const { rows } = await getPool().query<{ source_benefit_id: string | null }>(
      `SELECT source_benefit_id FROM public.salary_line_items WHERE id = $1`,
      [lineId],
    )
    expect(rows[0].source_benefit_id).toBe(s.benefitId)
  })

  it('still hard-deletes a benefit nothing derives from', async () => {
    const s = await seed()
    const del = await getPool().query(`DELETE FROM public.employee_benefits WHERE id = $1`, [
      s.benefitId,
    ])
    expect(del.rowCount).toBe(1)
  })
})

describe('benefit delete racing a recalculation (#2801)', () => {
  it('a delete that overlaps an uncommitted derivation waits, then fails: no orphan', async () => {
    // The interleaving the count-then-delete could not close. The calculation
    // has inserted its derived line but not committed; the delete starts now,
    // so any application-side count of referencing lines would have read 0.
    const s = await seed()
    const calc = await getClient()
    const del = await getClient()
    try {
      await calc.query('BEGIN')
      const lineId = await deriveLine(calc, s) // takes FOR KEY SHARE on the benefit row

      const delPid = await backendPid(del)
      const pending = del
        .query(`DELETE FROM public.employee_benefits WHERE id = $1`, [s.benefitId])
        .then(
          () => ({ ok: true as const }),
          (err: { code?: string }) => ({ ok: false as const, code: err.code }),
        )

      await waitUntilBlocked(delPid)
      await calc.query('COMMIT')

      // Under SET NULL this resolved ok and nulled the line just committed.
      expect(await pending).toEqual({ ok: false, code: '23503' })

      const { rows } = await getPool().query<{ source_benefit_id: string | null }>(
        `SELECT source_benefit_id FROM public.salary_line_items WHERE id = $1`,
        [lineId],
      )
      expect(rows[0].source_benefit_id).toBe(s.benefitId)
      expect(await orphanCount(s.companyId)).toBe(0)
    } finally {
      await calc.query('ROLLBACK').catch(() => {})
      calc.release()
      del.release()
    }
  })

  it('a derivation that overlaps an uncommitted delete waits, then fails: no orphan', async () => {
    // The mirror ordering: the delete wins. The derived insert must fail
    // closed rather than land a line that points at nothing.
    const s = await seed()
    const calc = await getClient()
    const del = await getClient()
    try {
      await del.query('BEGIN')
      await del.query(`DELETE FROM public.employee_benefits WHERE id = $1`, [s.benefitId])

      const calcPid = await backendPid(calc)
      const pending = deriveLine(calc, s).then(
        () => ({ ok: true as const }),
        (err: { code?: string }) => ({ ok: false as const, code: err.code }),
      )

      await waitUntilBlocked(calcPid)
      await del.query('COMMIT')

      expect(await pending).toEqual({ ok: false, code: '23503' })
      expect(await orphanCount(s.companyId)).toBe(0)
    } finally {
      await del.query('ROLLBACK').catch(() => {})
      calc.release()
      del.release()
    }
  })
})

describe('deleters that remove both sides are not blocked', () => {
  it('a salary run delete takes its derived lines, after which the benefit deletes', async () => {
    const s = await seed()
    await deriveLine(getPool(), s)

    await getPool().query(
      `DELETE FROM public.salary_runs
        WHERE id = (SELECT salary_run_id FROM public.salary_run_employees WHERE id = $1)`,
      [s.sreId],
    )
    const del = await getPool().query(`DELETE FROM public.employee_benefits WHERE id = $1`, [
      s.benefitId,
    ])
    expect(del.rowCount).toBe(1)
  })
})
