import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Regression lock for the franvaro-specifikationsnummer trigger under the
 * `authenticated` role (feedback 2026-08-13: register_absence 500 for
 * foraldraledighet/VAB).
 *
 * Migration 20260517135000 made the BEFORE INSERT trigger on
 * salary_absence_days write an audit row into salary_absence_franvaro_audit,
 * a table with RLS enabled and zero policies, from a SECURITY INVOKER
 * function. Every vab/parental INSERT from a non-BYPASSRLS role then failed
 * with 42501 while 'sick' (which skips the trigger) kept working. Migration
 * 20260813120000 makes both trigger functions SECURITY DEFINER with a pinned
 * search_path; these tests fail with /row-level security|permission denied/
 * without it.
 *
 * The audit table deliberately has no policies (trigger/service-only
 * writes), so audit assertions run on the superuser pool connection after
 * RESET ROLE inside the same transaction (withUserContext always rolls back,
 * so nothing persists across tests).
 */

async function insertEmployee(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  // personnummer must be 12 digits; last4 mirrors the last four chars.
  const pnr = '199001011234'
  await getPool().query(
    `INSERT INTO public.employees
       (id, user_id, company_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start, monthly_salary, tax_table_number)
     VALUES ($1, $2, $3, 'Test', 'Person', $4, '1234', '2026-01-01', 30000, 32)`,
    [id, params.userId, params.companyId, pnr],
  )
  return id
}

async function insertAbsenceDayAs(
  client: PoolClient,
  params: {
    companyId: string
    employeeId: string
    date: string
    type: string
  },
): Promise<{ id: string; specnummer: number | null }> {
  const res = await client.query<{ id: string; franvaro_specifikationsnummer: number | null }>(
    `INSERT INTO public.salary_absence_days
       (company_id, employee_id, absence_date, absence_type, hours)
     VALUES ($1, $2, $3, $4, 8)
     RETURNING id, franvaro_specifikationsnummer`,
    [params.companyId, params.employeeId, params.date, params.type],
  )
  return {
    id: res.rows[0]!.id,
    specnummer: res.rows[0]!.franvaro_specifikationsnummer,
  }
}

interface AuditRow {
  absence_day_id: string
  year_month: string
  new_specifikationsnummer: number
  trigger_op: string
}

/** Read the audit table as superuser (no policies exist by design). */
async function readAudit(client: PoolClient, employeeId: string): Promise<AuditRow[]> {
  await client.query('RESET ROLE')
  const res = await client.query<AuditRow>(
    `SELECT absence_day_id, year_month, new_specifikationsnummer, trigger_op
       FROM public.salary_absence_franvaro_audit
      WHERE employee_id = $1
      ORDER BY assigned_at, new_specifikationsnummer`,
    [employeeId],
  )
  return res.rows
}

describe('franvaro-specnummer.pg: authenticated-role vab/parental inserts', () => {
  it('parental INSERT succeeds under role authenticated and mints the shared per-month sequence + audit rows', async () => {
    const a = await seedCompany()
    const emp = await insertEmployee({ userId: a.userId, companyId: a.companyId })

    await withUserContext(a.userId, async (client) => {
      const day1 = await insertAbsenceDayAs(client, {
        companyId: a.companyId,
        employeeId: emp,
        date: '2026-03-02',
        type: 'parental',
      })
      expect(day1.specnummer).toBe(1)

      const day2 = await insertAbsenceDayAs(client, {
        companyId: a.companyId,
        employeeId: emp,
        date: '2026-03-03',
        type: 'parental',
      })
      expect(day2.specnummer).toBe(2)

      // vab shares the same per-(employee, year-month) sequence.
      const vabDay = await insertAbsenceDayAs(client, {
        companyId: a.companyId,
        employeeId: emp,
        date: '2026-03-04',
        type: 'vab',
      })
      expect(vabDay.specnummer).toBe(3)

      // A different month restarts the sequence.
      const aprilDay = await insertAbsenceDayAs(client, {
        companyId: a.companyId,
        employeeId: emp,
        date: '2026-04-01',
        type: 'parental',
      })
      expect(aprilDay.specnummer).toBe(1)

      const audit = await readAudit(client, emp)
      expect(audit).toHaveLength(4)
      expect(audit.every((r) => r.trigger_op === 'insert')).toBe(true)
      const march = audit.filter((r) => r.year_month === '2026-03')
      expect(march.map((r) => r.new_specifikationsnummer)).toEqual([1, 2, 3])
      expect(march.map((r) => r.absence_day_id)).toEqual([day1.id, day2.id, vabDay.id])
      const april = audit.filter((r) => r.year_month === '2026-04')
      expect(april.map((r) => r.new_specifikationsnummer)).toEqual([1])
    })
  })

  it('sick days skip the trigger: no specnummer, no audit row', async () => {
    const a = await seedCompany()
    const emp = await insertEmployee({ userId: a.userId, companyId: a.companyId })

    await withUserContext(a.userId, async (client) => {
      const sickDay = await insertAbsenceDayAs(client, {
        companyId: a.companyId,
        employeeId: emp,
        date: '2026-03-02',
        type: 'sick',
      })
      expect(sickDay.specnummer).toBeNull()

      const audit = await readAudit(client, emp)
      expect(audit).toHaveLength(0)
    })
  })

  it('upsert retry (ON CONFLICT DO UPDATE) is idempotent: no error, specnummer unchanged', async () => {
    const a = await seedCompany()
    const emp = await insertEmployee({ userId: a.userId, companyId: a.companyId })

    await withUserContext(a.userId, async (client) => {
      const day1 = await insertAbsenceDayAs(client, {
        companyId: a.companyId,
        employeeId: emp,
        date: '2026-03-02',
        type: 'parental',
      })
      expect(day1.specnummer).toBe(1)

      // Mirror the PostgREST upsert lib/salary/absence.ts sends: the payload
      // columns land in SET, franvaro_specifikationsnummer is never touched.
      const retry = await client.query<{ franvaro_specifikationsnummer: number | null }>(
        `INSERT INTO public.salary_absence_days
           (company_id, employee_id, absence_date, absence_type, hours)
         VALUES ($1, $2, '2026-03-02', 'parental', 4)
         ON CONFLICT (employee_id, absence_date, absence_type)
         DO UPDATE SET hours = EXCLUDED.hours
         RETURNING franvaro_specifikationsnummer`,
        [a.companyId, emp],
      )
      expect(retry.rows[0]!.franvaro_specifikationsnummer).toBe(1)
    })
  })

  it('both trigger functions are SECURITY DEFINER with a pinned search_path', async () => {
    const res = await getPool().query<{
      proname: string
      prosecdef: boolean
      proconfig: string[] | null
    }>(
      `SELECT proname, prosecdef, proconfig
         FROM pg_proc
        WHERE proname IN (
          'assign_franvaro_specifikationsnummer',
          'assign_franvaro_specifikationsnummer_on_update'
        )`,
    )
    expect(res.rows).toHaveLength(2)
    for (const row of res.rows) {
      expect(row.prosecdef).toBe(true)
      expect(row.proconfig ?? []).toContain('search_path=public, pg_temp')
    }
  })
})
