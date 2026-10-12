/**
 * pg-real test for migration 20261012100300_drop_dead_callable_functions.sql.
 *
 * Seven functions had no caller left but kept EXECUTE for authenticated, so
 * any signed-in user could still call them through PostgREST. The migration
 * drops them. This pins that none of them (in any overload) comes back, that
 * neither API role can call them, and that the live team path stays.
 */
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

interface PgError extends Error {
  code?: string
}

const DROPPED: Array<{ signature: string; call: string }> = [
  {
    signature: 'public.reserve_voucher_range(uuid,uuid,text,integer)',
    call: `SELECT public.reserve_voucher_range(gen_random_uuid(), gen_random_uuid(), 'A', 10)`,
  },
  {
    signature: 'public.release_voucher_range(uuid,uuid,text,integer,integer)',
    call: `SELECT public.release_voucher_range(gen_random_uuid(), gen_random_uuid(), 'A', 5, 10)`,
  },
  {
    signature: 'public.list_peppol_delivery_summaries(uuid,uuid)',
    call: `SELECT * FROM public.list_peppol_delivery_summaries(gen_random_uuid(), gen_random_uuid())`,
  },
  {
    signature: 'public.create_team_with_owner(text)',
    call: `SELECT public.create_team_with_owner('Team')`,
  },
  {
    signature: 'public.validate_version_chain(uuid)',
    call: `SELECT * FROM public.validate_version_chain(gen_random_uuid())`,
  },
  {
    signature: 'public.company_has_capability(uuid,text)',
    call: `SELECT public.company_has_capability(gen_random_uuid(), 'ai')`,
  },
  {
    signature: 'public.normalize_country_code(text)',
    call: `SELECT public.normalize_country_code('Sverige')`,
  },
]

const DROPPED_NAMES = DROPPED.map((d) => d.signature.replace(/^public\.|\(.*$/g, ''))

/** Run `sql` as `role` in a rolled-back transaction; return the error or null. */
async function callAs(role: 'anon' | 'authenticated', userId: string | null, sql: string): Promise<PgError | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ])
    if (userId) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE ${role}`)
    await client.query(sql)
    return null
  } catch (err) {
    return err as PgError
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('dead callable functions are gone (20261012100300)', () => {
  it('no dropped signature resolves', async () => {
    for (const { signature } of DROPPED) {
      const { rows } = await getPool().query<{ fn: string | null }>(
        `SELECT to_regprocedure($1)::text AS fn`,
        [signature],
      )
      expect(rows[0]!.fn, signature).toBeNull()
    }
  })

  it('no overload of any dropped name is left in public', async () => {
    const { rows } = await getPool().query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = ANY ($1::text[])`,
      [DROPPED_NAMES],
    )
    expect(rows.map((r) => r.fn)).toEqual([])
  })

  it('neither authenticated nor anon can execute any of them', async () => {
    const userId = await insertAuthUser()
    for (const { signature, call } of DROPPED) {
      const asUser = await callAs('authenticated', userId, call)
      expect(asUser?.code, `${signature} as authenticated`).toBe('42883')
      const asAnon = await callAs('anon', null, call)
      expect(asAnon?.code, `${signature} as anon`).toBe('42883')
    }
  })

  it('keeps ensure_user_team, the live team path', async () => {
    const userId = await insertAuthUser()
    await withUserContext(userId, async (c) => {
      const res = await c.query<{ team_id: string }>(`SELECT public.ensure_user_team() AS team_id`)
      const mine = await c.query<{ role: string }>(
        `SELECT role FROM public.team_members WHERE team_id = $1 AND user_id = $2`,
        [res.rows[0]!.team_id, userId],
      )
      expect(mine.rows[0]).toMatchObject({ role: 'owner' })
    })
  })
})
