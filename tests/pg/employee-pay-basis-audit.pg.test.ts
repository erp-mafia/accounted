import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { ACTOR_HEADER, actorHeaderValue } from '@/lib/supabase/actor-header'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import { EMPLOYEE_PAY_FIELDS } from '@/lib/reports/behandlingshistorik'

/**
 * Covers 20261101003400_employee_pay_basis_audit (accounted#30): who changed
 * an employee's pay basis, and when, lands in audit_log; the personnummer,
 * bank account and contact details never do; edits that leave the pay basis
 * alone write nothing; the actor is resolved like write_audit_log (session,
 * then the service-role request's x-accounted-actor header, then the row's
 * user_id).
 */

interface AuditRow {
  action: string
  user_id: string | null
  actor_id: string | null
  actor_type: string | null
  actor_label: string | null
  old_state: Record<string, unknown> | null
  new_state: Record<string, unknown> | null
}

const SELECT_AUDIT = `SELECT action, user_id, actor_id, actor_type, actor_label, old_state, new_state
                        FROM public.audit_log
                       WHERE table_name = 'employees' AND record_id = $1
                       ORDER BY created_at, id`

/** The employee's audit rows: on the given client (inside its transaction), else committed. */
async function auditRows(employeeId: string, client?: PoolClient): Promise<AuditRow[]> {
  const { rows } = client
    ? await client.query<AuditRow>(SELECT_AUDIT, [employeeId])
    : await getPool().query<AuditRow>(SELECT_AUDIT, [employeeId])
  return rows
}

/** A company with its owner (the employee's creator) and an admin who did not create the employee. */
async function companyWithEmployee(): Promise<{ creatorId: string; adminId: string; companyId: string; employeeId: string }> {
  const { userId: creatorId, companyId } = await seedCompany()
  const adminId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_start, monthly_salary, clearing_number, bank_account_number, email, city)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'sealed-pnr-payload', '0000',
             '2026-01-01', 30000, '8327', '9999999999', 'anstalld@example.test', 'Ort')`,
    [employeeId, companyId, creatorId],
  )
  return { creatorId, adminId, companyId, employeeId }
}

/** A service-role request carrying these headers, as PostgREST runs it (committed). */
function serviceRoleRequest<T>(headers: Record<string, string>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsServiceRole(async (client) => {
    await client.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify(headers)])
    return fn(client)
  })
}

function actingFor(actor: CommitActor): Record<string, string> {
  return { [ACTOR_HEADER]: actorHeaderValue(actor)!, 'user-agent': 'supabase-js-node' }
}

const NEVER_LOGGED = [
  'personnummer', 'personnummer_last4', 'clearing_number', 'bank_account_number',
  'email', 'phone', 'address_line1', 'postal_code', 'city', 'tax_municipality',
  'id', 'company_id', 'user_id', 'specification_number', 'created_at', 'updated_at',
]

describe('audit_employee_pay_basis', () => {
  it('logs the starting pay basis and the name on INSERT, and nothing that identifies or pays out to the person', async () => {
    const { creatorId, employeeId } = await companyWithEmployee()

    const rows = await auditRows(employeeId)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({ action: 'INSERT', user_id: creatorId, actor_id: creatorId, actor_type: 'user', actor_label: null, old_state: null })
    expect(row.new_state).toMatchObject({ first_name: 'Test', last_name: 'Testsson', monthly_salary: 30000, employment_degree: 100, vacation_rule: 'procentregeln' })
    // Exactly the labelled pay basis plus the name.
    expect(Object.keys(row.new_state!).sort()).toEqual([...Object.keys(EMPLOYEE_PAY_FIELDS), 'first_name', 'last_name'].sort())
    for (const key of NEVER_LOGGED) expect(row.new_state).not.toHaveProperty(key)
    expect(JSON.stringify(row)).not.toMatch(/sealed-pnr-payload|9999999999|8327|anstalld@example/)
  })

  it('a signed-in admin raising the salary is logged under the admin, old and new, not under the creator', async () => {
    const { creatorId, adminId, employeeId } = await companyWithEmployee()

    const rows = await withUserContext(adminId, async (client) => {
      const res = await client.query(
        `UPDATE public.employees SET monthly_salary = 32500, employment_degree = 80 WHERE id = $1`,
        [employeeId],
      )
      expect(res.rowCount).toBe(1)
      return auditRows(employeeId, client)
    })

    const updates = rows.filter((r) => r.action === 'UPDATE')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ user_id: adminId, actor_id: adminId, actor_type: 'user', actor_label: null })
    expect(updates[0].old_state).toMatchObject({ monthly_salary: 30000, employment_degree: 100 })
    expect(updates[0].new_state).toMatchObject({ monthly_salary: 32500, employment_degree: 80 })
    for (const key of NEVER_LOGGED) {
      expect(updates[0].old_state).not.toHaveProperty(key)
      expect(updates[0].new_state).not.toHaveProperty(key)
    }
    expect(creatorId).not.toBe(adminId)
  })

  it('writes nothing when only the bank account, contact details, personnummer or name change', async () => {
    const { adminId, employeeId } = await companyWithEmployee()

    const rows = await withUserContext(adminId, async (client) => {
      await client.query(
        `UPDATE public.employees
            SET bank_account_number = '1111111111', clearing_number = '6000', email = 'ny@example.test',
                phone = '0700000000', address_line1 = 'Gatan 1', postal_code = '11122', city = 'Annan ort',
                tax_municipality = 'Kommun', personnummer = 'resealed-pnr-payload', last_name = 'Annan'
          WHERE id = $1`,
        [employeeId],
      )
      // Setting a pay column to the value it already has is no change either.
      await client.query(`UPDATE public.employees SET monthly_salary = 30000 WHERE id = $1`, [employeeId])
      return auditRows(employeeId, client)
    })

    expect(rows.map((r) => r.action)).toEqual(['INSERT'])
  })

  it('a soft delete (is_active = false) is logged as a pay-basis change', async () => {
    const { adminId, employeeId } = await companyWithEmployee()

    const rows = await withUserContext(adminId, async (client) => {
      await client.query(`UPDATE public.employees SET is_active = false WHERE id = $1`, [employeeId])
      return auditRows(employeeId, client)
    })

    const update = rows.find((r) => r.action === 'UPDATE')
    expect(update?.old_state).toMatchObject({ is_active: true })
    expect(update?.new_state).toMatchObject({ is_active: false })
  })

  it('an MCP connector changing the tax table for an admin names the admin and the connector', async () => {
    const { adminId, employeeId } = await companyWithEmployee()

    await serviceRoleRequest(actingFor({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: adminId }), async (client) => {
      const res = await client.query(`UPDATE public.employees SET tax_table_number = 34, tax_column = 1 WHERE id = $1`, [employeeId])
      expect(res.rowCount).toBe(1)
    })

    const update = (await auditRows(employeeId)).find((r) => r.action === 'UPDATE')
    expect(update).toMatchObject({ user_id: adminId, actor_id: adminId, actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' })
    expect(update?.new_state).toMatchObject({ tax_table_number: 34 })
  })

  it('a service-role write that names nobody falls back to the row user_id, as write_audit_log does', async () => {
    const { creatorId, employeeId } = await companyWithEmployee()

    await serviceRoleRequest({ 'user-agent': 'supabase-js-node' }, (client) =>
      client.query(`UPDATE public.employees SET vacation_days_per_year = 30 WHERE id = $1`, [employeeId]),
    )

    const update = (await auditRows(employeeId)).find((r) => r.action === 'UPDATE')
    expect(update).toMatchObject({ user_id: creatorId, actor_id: creatorId, actor_type: 'user', actor_label: null })
    expect(update?.old_state).toMatchObject({ vacation_days_per_year: 25 })
    expect(update?.new_state).toMatchObject({ vacation_days_per_year: 30 })
  })

  it('stays out of the sandbox teardown', async () => {
    const { employeeId } = await companyWithEmployee()

    const client = await getPool().connect()
    let actions: string[]
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await client.query(`UPDATE public.employees SET monthly_salary = 1 WHERE id = $1`, [employeeId])
      actions = (await auditRows(employeeId, client)).map((r) => r.action)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(actions).toEqual(['INSERT'])
  })

  it('behandlingshistorik_sources hands the rows to the report', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const employeeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.employees
         (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start, monthly_salary)
       VALUES ($1, $2, $3, 'Test', 'Testsson', 'sealed-pnr-payload', '0000', '2026-01-01', 30000)`,
      [employeeId, companyId, userId],
    )
    await getPool().query(`UPDATE public.employees SET monthly_salary = 31000 WHERE id = $1`, [employeeId])

    const audit = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ audit: Array<{ table_name: string; record_id: string; action: string }> }>(
        `SELECT audit FROM public.behandlingshistorik_sources($1, $2, now() - interval '1 hour', now() + interval '1 hour', false)`,
        [companyId, fiscalPeriodId],
      )
      return rows[0].audit
    })

    expect(
      audit.filter((r) => r.table_name === 'employees' && r.record_id === employeeId).map((r) => r.action).sort(),
    ).toEqual(['INSERT', 'UPDATE'])
  })
})
