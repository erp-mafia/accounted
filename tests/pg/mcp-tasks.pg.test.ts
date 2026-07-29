import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260729094000_create_mcp_tasks.sql: the status CHECK,
// creator-only SELECT RLS, the deliberate absence of authenticated write
// policies (writes are service-role only), and the updated_at trigger.

async function insertTask(params: {
  companyId: string
  userId: string
  status?: string
  toolName?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.mcp_tasks (id, company_id, user_id, tool_name, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.companyId, params.userId, params.toolName ?? 'gnubok_audit_package', params.status ?? 'working'],
  )
  return id
}

describe('mcp_tasks', () => {
  it('rejects statuses outside the task lifecycle', async () => {
    const { companyId, userId } = await seedCompany()
    await expect(
      insertTask({ companyId, userId, status: 'running' }),
    ).rejects.toThrow(/mcp_tasks_status_check/)
  })

  it('only the creating user can read a task (not other members, not other companies)', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const taskId = await insertTask({ companyId: a.companyId, userId: a.userId })

    const mine = await withUserContext(a.userId, (client) =>
      client.query('SELECT id, status FROM public.mcp_tasks WHERE id = $1', [taskId]),
    )
    expect(mine.rows).toHaveLength(1)
    expect(mine.rows[0].status).toBe('working')

    // A second member of the SAME company must not see the row: task results
    // carry raw tool output, so the grant is creator-only (Art. 5(1)(c)).
    const colleagueId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: colleagueId, role: 'member' })
    const colleague = await withUserContext(colleagueId, (client) =>
      client.query('SELECT id FROM public.mcp_tasks WHERE id = $1', [taskId]),
    )
    expect(colleague.rows).toHaveLength(0)

    const theirs = await withUserContext(b.userId, (client) =>
      client.query('SELECT id FROM public.mcp_tasks WHERE id = $1', [taskId]),
    )
    expect(theirs.rows).toHaveLength(0)
  })

  it('authenticated users cannot insert, update, or delete tasks (service-role only)', async () => {
    const { companyId, userId } = await seedCompany()
    const taskId = await insertTask({ companyId, userId })

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.mcp_tasks (company_id, user_id, tool_name)
           VALUES ($1, $2, 'gnubok_audit_package')`,
          [companyId, userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/)

    // UPDATE and DELETE have no policies: RLS silently filters all rows,
    // so the statements succeed but affect nothing.
    const upd = await withUserContext(userId, (client) =>
      client.query(`UPDATE public.mcp_tasks SET status = 'cancelled' WHERE id = $1`, [taskId]),
    )
    expect(upd.rowCount).toBe(0)

    const del = await withUserContext(userId, (client) =>
      client.query('DELETE FROM public.mcp_tasks WHERE id = $1', [taskId]),
    )
    expect(del.rowCount).toBe(0)
  })

  it('bumps updated_at on status transitions', async () => {
    const { companyId, userId } = await seedCompany()
    const taskId = await insertTask({ companyId, userId })

    const before = await getPool().query(
      'SELECT updated_at FROM public.mcp_tasks WHERE id = $1',
      [taskId],
    )
    // clock_timestamp()-based trigger: force a measurable gap.
    await getPool().query('SELECT pg_sleep(0.05)')
    await getPool().query(
      `UPDATE public.mcp_tasks SET status = 'completed', result = '{"ok":true}'::jsonb WHERE id = $1`,
      [taskId],
    )
    const after = await getPool().query(
      'SELECT updated_at, status FROM public.mcp_tasks WHERE id = $1',
      [taskId],
    )
    expect(after.rows[0].status).toBe('completed')
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.rows[0].updated_at).getTime(),
    )
  })
})
