/**
 * pg-real test for the extension_data upsert target.
 *
 * Since 20260330130000 the only unique key on extension_data is
 * (company_id, extension_id, key): the multi-tenant refactor dropped the
 * table's original inline `unique(user_id, extension_id, key)` by the name
 * Postgres generated for it. The generic extension data route kept
 * `onConflict: 'user_id,extension_id,key'`, so every save raised 42P10.
 *
 * These cases run the statement PostgREST builds for the route's upsert, as a
 * company member under RLS, and pin the constraint naming that
 * tests/schema/schema-guard.ts replays: the guard missed this drop because it
 * did not know the generated name.
 */
import { describe, it, expect } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'
import { defaultConstraintName } from '../schema/schema-guard'

const EXTENSION_ID = 'general/tic'

async function seedActiveCompany() {
  const seeded = await seedCompany()
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [seeded.userId, seeded.companyId],
  )
  return seeded
}

// The statement PostgREST issues for
// .upsert({ user_id, company_id, extension_id, key, value }, { onConflict })
function upsertSql(conflictTarget: string): string {
  return `INSERT INTO public.extension_data (user_id, company_id, extension_id, key, value)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (${conflictTarget}) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            company_id = EXCLUDED.company_id,
            extension_id = EXCLUDED.extension_id,
            key = EXCLUDED.key,
            value = EXCLUDED.value
          RETURNING value`
}

describe('extension_data upsert', () => {
  it('saving the same key twice keeps one row with the latest value', async () => {
    const { userId, companyId } = await seedActiveCompany()

    const rows = await withUserContext(userId, async (client) => {
      const sql = upsertSql('company_id, extension_id, key')
      await client.query(sql, [userId, companyId, EXTENSION_ID, 'profile', { step: 1 }])
      const second = await client.query(sql, [userId, companyId, EXTENSION_ID, 'profile', { step: 2 }])
      expect(second.rows[0].value).toEqual({ step: 2 })
      const { rows } = await client.query(
        `SELECT value FROM public.extension_data
          WHERE company_id = $1 AND extension_id = $2 AND key = 'profile'`,
        [companyId, EXTENSION_ID],
      )
      return rows
    })

    expect(rows).toEqual([{ value: { step: 2 } }])
  })

  it('the old user-scoped target matches no constraint (42P10)', async () => {
    const { userId, companyId } = await seedActiveCompany()

    await expect(
      withUserContext(userId, (client) =>
        client.query(upsertSql('user_id, extension_id, key'), [
          userId,
          companyId,
          EXTENSION_ID,
          'profile',
          { step: 1 },
        ]),
      ),
    ).rejects.toMatchObject({ code: '42P10' })
  })
})

describe('generated constraint names the schema guard replays', () => {
  async function constraintNames(ddl: string, table: string): Promise<string[]> {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(ddl)
      const { rows } = await client.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype IN ('p', 'u')
          ORDER BY conname`,
        [`public.${table}`],
      )
      return rows.map((r) => r.conname)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  it('matches Postgres for short names', async () => {
    const table = 'guard_probe_short'
    const names = await constraintNames(
      `CREATE TABLE public.${table} (
         id uuid PRIMARY KEY,
         code text UNIQUE,
         user_id uuid, extension_id text, key text,
         unique (user_id, extension_id, key)
       )`,
      table,
    )
    expect(names).toEqual(
      [
        defaultConstraintName(table, ['code'], 'key'),
        defaultConstraintName(table, ['id'], 'pkey'),
        defaultConstraintName(table, ['user_id', 'extension_id', 'key'], 'key'),
      ].sort(),
    )
  })

  it('matches Postgres when the name is cut to 63 bytes', async () => {
    const table = 'guard_probe_with_a_table_name_long_enough_to_be_truncated'
    const columns = ['company_identifier_for_probe', 'extension_identifier_for_probe', 'key']
    const names = await constraintNames(
      `CREATE TABLE public.${table} (
         id uuid,
         ${columns.map((c) => `${c} text`).join(', ')},
         PRIMARY KEY (id),
         UNIQUE (${columns.join(', ')})
       )`,
      table,
    )
    expect(names).toEqual(
      [
        defaultConstraintName(table, ['id'], 'pkey'),
        defaultConstraintName(table, columns, 'key'),
      ].sort(),
    )
  })
})
