import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Account deletion RPCs (issue #342):
 *
 * Migration 20260706100000 drops public.delete_user_account, the SECURITY
 * DEFINER RPC that disabled the BFL retention triggers, deleted audit_log
 * rows, and cascaded auth.users, destroying rakenskapsinformation that
 * BFL 7 kap 2 paragraf requires us to retain for 7 years. These tests pin
 * that the function stays gone and that the surviving anonymize-only flow
 * (public.anonymize_user_account) is present, SECURITY DEFINER, and not
 * callable by anon/PUBLIC.
 */
describe('account deletion RPCs (pg)', () => {
  it('delete_user_account no longer exists in pg_proc', async () => {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'delete_user_account'`,
    )
    expect(rows[0]!.n).toBe(0)
  })

  it('anonymize_user_account exists and is SECURITY DEFINER', async () => {
    const { rows } = await getPool().query<{ prosecdef: boolean }>(
      `SELECT p.prosecdef
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'anonymize_user_account'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.prosecdef).toBe(true)
  })

  it('anonymize_user_account has no EXECUTE grant for anon or PUBLIC, but authenticated has it', async () => {
    // anon inherits any PUBLIC grant, so anon=false also proves PUBLIC=false;
    // the aclexplode check makes the PUBLIC assertion explicit (grantee oid 0).
    const { rows } = await getPool().query<{
      anon_can_execute: boolean
      authenticated_can_execute: boolean
      public_grant_count: number
    }>(
      `SELECT
         has_function_privilege('anon', 'public.anonymize_user_account(uuid)', 'EXECUTE')
           AS anon_can_execute,
         has_function_privilege('authenticated', 'public.anonymize_user_account(uuid)', 'EXECUTE')
           AS authenticated_can_execute,
         (SELECT count(*)::int
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace,
          LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE n.nspname = 'public'
            AND p.proname = 'anonymize_user_account'
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE') AS public_grant_count`,
    )
    expect(rows[0]!.anon_can_execute).toBe(false)
    expect(rows[0]!.public_grant_count).toBe(0)
    expect(rows[0]!.authenticated_can_execute).toBe(true)
  })

  it('denies EXECUTE to the anon role at call time', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(
        client.query('SELECT public.anonymize_user_account($1)', [randomUUID()]),
      ).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('refuses to anonymize while the user still owns an active company', async () => {
    const { userId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query('SELECT public.anonymize_user_account($1)', [userId]),
      ).rejects.toThrow(/still owns/i)
    })
  })

  it('refuses to anonymize another user', async () => {
    const userId = await insertAuthUser()
    const victimId = await insertAuthUser()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query('SELECT public.anonymize_user_account($1)', [victimId]),
      ).rejects.toThrow(/only delete your own account/i)
    })
  })

  it('anonymizes a company-less user: scrubs profile PII, sets tombstones', async () => {
    const userId = await insertAuthUser()
    // insertAuthUser may or may not fire a profiles trigger depending on the
    // harness image; make the profile row deterministic.
    await getPool().query(
      `INSERT INTO public.profiles (id, email, full_name)
       VALUES ($1, $2, 'PG Real')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
      [userId, `pg-real-${userId}@test.invalid`],
    )

    await withUserContext(userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [userId])
      const { rows } = await client.query<{
        email: string | null
        full_name: string | null
        deleted_at: string | null
        anonymized_at: string | null
      }>(
        `SELECT email, full_name, deleted_at, anonymized_at
         FROM public.profiles WHERE id = $1`,
        [userId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.email).toBeNull()
      expect(rows[0]!.full_name).toBeNull()
      expect(rows[0]!.deleted_at).not.toBeNull()
      expect(rows[0]!.anonymized_at).not.toBeNull()
    })
    // withUserContext rolls back, so the seeded rows do not leak.
  })

  it('scrubs auth.users: email cleared, user_metadata wiped, app keys dropped, provider kept', async () => {
    // Migration 20260724150000: the route-level updateUserById "wipe" was a
    // silent no-op (GoTrue merges metadata maps), so the tombstone kept the
    // user's full name. The RPC now scrubs auth.users directly. Since
    // *_complete_account_erasure.sql the email is cleared as well: keeping it
    // indefinitely contradicted the published retention period.
    const userId = await insertAuthUser()
    await getPool().query(
      `UPDATE auth.users
       SET raw_user_meta_data = '{"full_name": "PG Real Person", "email_verified": true}'::jsonb,
           raw_app_meta_data  = '{"provider": "email", "providers": ["email"], "bankid_linked": true, "has_password": false}'::jsonb
       WHERE id = $1`,
      [userId],
    )

    await withUserContext(userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [userId])
      // The authenticated role has no SELECT on auth.users; drop back to the
      // superuser session user to verify. Still inside the same transaction,
      // so the rolled-back writes remain visible.
      await client.query('RESET ROLE')
      const { rows } = await client.query<{
        email: string | null
        user_meta: Record<string, unknown>
        app_meta: Record<string, unknown>
      }>(
        `SELECT email, raw_user_meta_data AS user_meta, raw_app_meta_data AS app_meta
         FROM auth.users WHERE id = $1`,
        [userId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.email).toBeNull()
      expect(rows[0]!.user_meta).toEqual({})
      expect(rows[0]!.app_meta).toEqual({ provider: 'email', providers: ['email'] })
    })
  })

  it('rejects a repeat invocation against an already-anonymized tombstone', async () => {
    const userId = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.profiles (id, email, full_name)
       VALUES ($1, $2, 'PG Real')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
      [userId, `pg-real-${userId}@test.invalid`],
    )

    await withUserContext(userId, async (client) => {
      await client.query('SELECT public.anonymize_user_account($1)', [userId])
      await expect(
        client.query('SELECT public.anonymize_user_account($1)', [userId]),
      ).rejects.toThrow(/already deleted/i)
    })
  })
})
