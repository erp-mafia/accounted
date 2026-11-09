import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

// Migration 20261109180000: the send log of one-time announcement mails
// (extensions/general/skatteverket/lib/ombud-announcement.ts). The cron
// claims each (company, person) pair with an upsert that ignores duplicates
// before the mail goes, so the unique key is what keeps a person from being
// told twice; and only the service role may reach the table.

let a: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient

beforeEach(async () => {
  a = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
})
afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

const CLAIM = `INSERT INTO public.company_announcement_mails (announcement, company_id, user_id)
  VALUES ('skatteverket_ombud', $1, $2)
  ON CONFLICT (announcement, company_id, user_id) DO NOTHING
  RETURNING company_id`

describe('company_announcement_mails', () => {
  it('is RLS-enabled and reachable by the service role alone', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.company_announcement_mails'::regclass`,
    )
    expect(rls.rows[0].relrowsecurity).toBe(true)
    const privileges = await getPool().query(`
      SELECT has_table_privilege('authenticated', 'public.company_announcement_mails', 'SELECT') AS auth_select,
             has_table_privilege('authenticated', 'public.company_announcement_mails', 'INSERT') AS auth_insert,
             has_table_privilege('anon', 'public.company_announcement_mails', 'SELECT') AS anon_select,
             has_table_privilege('service_role', 'public.company_announcement_mails', 'INSERT') AS service_insert,
             has_table_privilege('service_role', 'public.company_announcement_mails', 'DELETE') AS service_delete`)
    expect(privileges.rows[0]).toEqual({ auth_select: false, auth_insert: false, anon_select: false, service_insert: true, service_delete: true })
  })

  it('claims a pair once: a second claim of the same pair returns nothing', async () => {
    await client.query('SET LOCAL ROLE service_role')
    expect((await client.query(CLAIM, [a.companyId, a.userId])).rows).toEqual([{ company_id: a.companyId }])
    expect((await client.query(CLAIM, [a.companyId, a.userId])).rows).toEqual([])
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.company_announcement_mails WHERE company_id = $1`, [a.companyId])
    expect(rows[0].n).toBe(1)
  })

  it('refuses an announcement it does not know', async () => {
    await expect(
      client.query(`INSERT INTO public.company_announcement_mails (announcement, company_id, user_id) VALUES ('something_else', $1, $2)`, [a.companyId, a.userId]),
    ).rejects.toThrow(/check constraint/)
  })
})
