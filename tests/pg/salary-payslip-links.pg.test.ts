/**
 * pg-real tests for 20260703191000_salary_payslip_links.sql.
 *
 * Verifies:
 *   - table exists with RLS enabled
 *   - select/insert/update policies exist, DELETE policy does NOT (links are
 *     revoked, never deleted)
 *   - UNIQUE (salary_run_id, employee_id) — one live link per employee/run
 *   - UNIQUE token_hash
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

async function seedRunAndEmployee(): Promise<{
  userId: string
  companyId: string
  runId: string
  employeeId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })

  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date)
     VALUES ($1, $2, $3, 2026, 6, '2026-06-25')`,
    [runId, companyId, userId],
  )

  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '1234', '2026-01-01')`,
    [employeeId, companyId, userId],
  )

  return { userId, companyId, runId, employeeId }
}

function tokenHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

async function insertLink(params: {
  companyId: string
  runId: string
  employeeId: string
  userId: string
  hash?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_payslip_links
       (id, company_id, salary_run_id, employee_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '90 days')`,
    [id, params.companyId, params.runId, params.employeeId, params.userId, params.hash ?? tokenHash(id)],
  )
  return id
}

describe('salary_payslip_links schema', () => {
  it('table exists with RLS enabled', async () => {
    const result = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'salary_payslip_links'`,
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].relrowsecurity).toBe(true)
  })

  it('has select/insert/update policies but no DELETE policy', async () => {
    const result = await getPool().query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'salary_payslip_links'`,
    )
    const cmds = result.rows.map(r => r.cmd).sort()
    expect(cmds).toEqual(['INSERT', 'SELECT', 'UPDATE'])
  })

  it('enforces one link per (salary_run_id, employee_id)', async () => {
    const seed = await seedRunAndEmployee()
    await insertLink(seed)
    await expect(insertLink(seed)).rejects.toThrow()
  })

  it('enforces unique token_hash across links', async () => {
    const a = await seedRunAndEmployee()
    const b = await seedRunAndEmployee()
    const sharedHash = tokenHash('shared')
    await insertLink({ ...a, hash: sharedHash })
    await expect(insertLink({ ...b, hash: sharedHash })).rejects.toThrow()
  })

  it('requires expires_at', async () => {
    const seed = await seedRunAndEmployee()
    await expect(
      getPool().query(
        `INSERT INTO public.salary_payslip_links
           (id, company_id, salary_run_id, employee_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
        [randomUUID(), seed.companyId, seed.runId, seed.employeeId, seed.userId, tokenHash(randomUUID())],
      ),
    ).rejects.toThrow()
  })
})
