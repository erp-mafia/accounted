import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from './setup'
import { insertAuthUser } from './fixtures'

// pg-real for migration 20261012100400: six never-used tables, the prod-only
// journal_entry_lines.cost_center_id/project_id columns and the retired
// bookkeeping digest are gone, and account erasure, which used to delete from
// extension_toggles, still runs.

const DROPPED_TABLES = [
  'tax_table_rates',
  'extension_toggles',
  'metered_events',
  'connector_peppol_submissions',
  'cost_centers',
  'projects',
]

async function columnsOf(table: string): Promise<string[]> {
  const { rows } = await getPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

describe('drop unused tables (pg)', () => {
  it('drops the six tables', async () => {
    const { rows } = await getPool().query<{ name: string; reg: string | null }>(
      `SELECT name, to_regclass('public.' || name)::text AS reg FROM unnest($1::text[]) AS name`,
      [DROPPED_TABLES],
    )
    expect(rows.filter((r) => r.reg !== null).map((r) => r.name)).toEqual([])
  })

  it('keeps the live text dimension columns on journal_entry_lines', async () => {
    const cols = await columnsOf('journal_entry_lines')
    expect(cols).toEqual(expect.arrayContaining(['cost_center', 'project']))
    expect(cols).not.toContain('cost_center_id')
    expect(cols).not.toContain('project_id')
  })

  it('removes the digest toggle, its dedup index and its notification type', async () => {
    expect(await columnsOf('notification_settings')).not.toContain('email_digest_enabled')

    const { rows: idx } = await getPool().query(
      `SELECT to_regclass('public.idx_notification_log_bookkeeping_digest_dedup')::text AS reg`,
    )
    expect(idx[0].reg).toBeNull()

    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.notification_log (user_id, notification_type, reference_id, days_before)
         VALUES ($1, 'bookkeeping_digest', $2, 0)`,
        [userId, randomUUID()],
      ),
    ).rejects.toThrow(/notification_log_notification_type_check/)
  })

  it('still erases an account end to end', async () => {
    const userId = await insertAuthUser()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO public.notification_settings (user_id) VALUES ($1)`, [userId])
      await client.query(`SELECT public.erase_user_personal_data($1)`, [userId])
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.notification_settings WHERE user_id = $1`,
        [userId],
      )
      expect(rows[0]!.n).toBe(0)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }

    const { rows: def } = await getPool().query<{ def: string }>(
      `SELECT pg_get_functiondef('public.erase_user_personal_data(uuid)'::regprocedure) AS def`,
    )
    expect(def[0]!.def).not.toMatch(/extension_toggles/)
  })
})
