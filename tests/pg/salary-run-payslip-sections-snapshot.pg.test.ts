/**
 * pg-real tests for the salary_runs payslip section snapshot in
 * 20260930200000_payslip_section_visibility.sql.
 *
 * Verifies:
 *   - a new run carries no snapshot (all three columns NULL = not yet issued)
 *   - the snapshot is all-or-nothing and never shows the breakdown without
 *     the employer cost (CHECK salary_runs_payslip_sections_snapshot_shape)
 *   - once issued it is written once: any change is refused by
 *     salary_runs_payslip_sections_write_once, other run columns stay editable
 *   - the application's guarded first-issue update matches nothing on a run
 *     that is already issued, so a later send cannot overwrite it
 *   - the backfill (the real statement from the migration) marks every run
 *     that may already have reached employees as issued with both sections:
 *     paid, booked and corrected runs even without a link or delivery, since
 *     the bulk download left no trace; an approved run without evidence stays
 *     unissued; an archived migration-reset source is left untouched
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

// The backfill exactly as it ships, cut from the migration by its markers.
const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260930200000_payslip_section_visibility.sql'),
  'utf8',
)
const BACKFILL_SQL = (() => {
  const match = /-- backfill:begin\n([\s\S]*?)-- backfill:end/.exec(MIGRATION_SQL)
  if (!match) throw new Error('backfill markers missing from the migration')
  return match[1]
})()

async function seedRunIn(status: string): Promise<{ runId: string; companyId: string; userId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 6, '2026-06-25', $4)`,
    [runId, companyId, userId, status],
  )
  return { runId, companyId, userId }
}

async function seedRun(): Promise<string> {
  return (await seedRunIn('approved')).runId
}

async function snapshotOf(runId: string) {
  const { rows } = await getPool().query<{
    payslip_sections_issued_at: Date | null
    payslip_show_employer_cost: boolean | null
    payslip_show_breakdown: boolean | null
  }>(
    `SELECT payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown
       FROM public.salary_runs WHERE id = $1`,
    [runId],
  )
  return rows[0]
}

/** The update issuePayslipSections sends: only a run without a snapshot matches. */
async function issue(runId: string, employerCost: boolean, breakdown: boolean): Promise<number> {
  const result = await getPool().query(
    `UPDATE public.salary_runs
        SET payslip_sections_issued_at = now(),
            payslip_show_employer_cost = $2,
            payslip_show_breakdown = $3
      WHERE id = $1 AND payslip_sections_issued_at IS NULL`,
    [runId, employerCost, breakdown],
  )
  return result.rowCount ?? 0
}

describe('salary_runs payslip section snapshot', () => {
  it('starts unissued: all three columns NULL', async () => {
    const runId = await seedRun()
    expect(await snapshotOf(runId)).toEqual({
      payslip_sections_issued_at: null,
      payslip_show_employer_cost: null,
      payslip_show_breakdown: null,
    })
  })

  it('refuses a partial snapshot', async () => {
    const runId = await seedRun()
    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_sections_issued_at = now() WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_show_employer_cost = true, payslip_show_breakdown = true WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a snapshot that shows the breakdown without the employer cost', async () => {
    const runId = await seedRun()
    await expect(issue(runId, false, true)).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps a run sent with sections shown: a later issue matches nothing', async () => {
    const runId = await seedRun()
    expect(await issue(runId, true, true)).toBe(1)
    const first = await snapshotOf(runId)

    // The company hides both sections and sends again.
    expect(await issue(runId, false, false)).toBe(0)
    expect(await snapshotOf(runId)).toEqual(first)
    expect(first.payslip_show_employer_cost).toBe(true)
    expect(first.payslip_show_breakdown).toBe(true)
  })

  it('refuses any change to an issued snapshot, for any caller', async () => {
    const runId = await seedRun()
    await issue(runId, true, false)

    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_show_employer_cost = false, payslip_show_breakdown = false WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.salary_runs
            SET payslip_sections_issued_at = NULL, payslip_show_employer_cost = NULL, payslip_show_breakdown = NULL
          WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `UPDATE public.salary_runs SET payslip_sections_issued_at = now() + interval '1 day' WHERE id = $1`,
        [runId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    const after = await snapshotOf(runId)
    expect(after.payslip_show_employer_cost).toBe(true)
    expect(after.payslip_show_breakdown).toBe(false)
  })

  it('leaves the rest of an issued run editable', async () => {
    const runId = await seedRun()
    await issue(runId, true, true)

    await getPool().query(`UPDATE public.salary_runs SET status = 'paid', notes = 'betald' WHERE id = $1`, [runId])
    const { rows } = await getPool().query<{ status: string; notes: string }>(
      `SELECT status, notes FROM public.salary_runs WHERE id = $1`,
      [runId],
    )
    expect(rows[0]).toEqual({ status: 'paid', notes: 'betald' })
  })
})

describe('salary_runs payslip section backfill', () => {
  type Snapshot = {
    payslip_sections_issued_at: Date | null
    payslip_show_employer_cost: boolean | null
    payslip_show_breakdown: boolean | null
    updated_at: Date
  }

  async function rowsOf(ids: string[]): Promise<Map<string, Snapshot>> {
    const { rows } = await getPool().query<Snapshot & { id: string }>(
      `SELECT id, payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown, updated_at
         FROM public.salary_runs WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    return new Map(rows.map(({ id, ...rest }) => [id, rest]))
  }

  it('issues every run that may have reached employees and leaves the rest', async () => {
    const booked = await seedRunIn('booked')
    const paid = await seedRunIn('paid')
    const corrected = await seedRunIn('corrected')
    const approved = await seedRunIn('approved')
    const alreadyIssued = await seedRunIn('booked')
    expect(await issue(alreadyIssued.runId, false, false)).toBe(1)

    // A booked run of a company archived by a migration reset: its rows are
    // immutable, so the backfill must not touch it (an UPDATE would raise and
    // abort the whole migration).
    const archived = await seedRunIn('booked')
    const replacementCompanyId = await insertCompany({ createdBy: archived.userId, name: 'Reset Replacement AB' })
    await getPool().query(
      `INSERT INTO public.company_migration_resets (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'pg-real payslip section backfill test', '{}'::jsonb, '{}'::jsonb)`,
      [archived.companyId, replacementCompanyId],
    )

    const ids = [booked, paid, corrected, approved, alreadyIssued, archived].map((r) => r.runId)
    const before = await rowsOf(ids)

    // Run the backfill in a transaction that is rolled back, so it neither
    // leaks into other tests nor depends on what they left in the table.
    const client = await getPool().connect()
    let after = new Map<string, Snapshot>()
    try {
      await client.query('BEGIN')
      await client.query(BACKFILL_SQL)
      const { rows } = await client.query<Snapshot & { id: string }>(
        `SELECT id, payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown, updated_at
           FROM public.salary_runs WHERE id = ANY($1::uuid[])`,
        [ids],
      )
      after = new Map(rows.map(({ id, ...rest }) => [id, rest]))
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }

    // Booked, paid and corrected without any link or delivery: issued with
    // both sections, at the run's last update before the backfill.
    for (const run of [booked, paid, corrected]) {
      const row = after.get(run.runId)!
      expect(row.payslip_show_employer_cost).toBe(true)
      expect(row.payslip_show_breakdown).toBe(true)
      expect(row.payslip_sections_issued_at).toEqual(before.get(run.runId)!.updated_at)
    }

    // Approved without evidence: not handed out yet, still follows the switches.
    expect(after.get(approved.runId)).toMatchObject({
      payslip_sections_issued_at: null,
      payslip_show_employer_cost: null,
      payslip_show_breakdown: null,
    })

    // An issued snapshot is never overwritten.
    expect(after.get(alreadyIssued.runId)).toEqual(before.get(alreadyIssued.runId))

    // The archived migration-reset source is untouched.
    expect(after.get(archived.runId)).toEqual(before.get(archived.runId))
  })
})
