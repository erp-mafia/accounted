import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

/**
 * Migration 20261102200822: API keys can no longer be created or changed from
 * a session that skipped MFA.
 *
 * The attack: the password of an owner who enrolled a factor buys an AAL1
 * token from GoTrue, and PostgREST took a POST /rest/v1/api_keys with a
 * key_hash the attacker chose. Two RESTRICTIVE policies now require AAL2 for
 * INSERT and UPDATE whenever the session's user has a verified factor;
 * revoking stays open at AAL1, users without a factor are untouched, and the
 * service role (every app path that mints a key) is outside RLS.
 */

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

type Aal = 'aal1' | 'aal2'

/**
 * Like withUserContext, plus the `aal` claim PostgREST hands the database
 * from the caller's JWT. Always rolls back.
 */
async function withSession<T>(userId: string, aal: Aal, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated', aal }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const result = await fn(client)
    await client.query('ROLLBACK')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function enrolFactor(userId: string, status: 'verified' | 'unverified' = 'verified'): Promise<void> {
  await getPool().query(
    `INSERT INTO auth.mfa_factors (user_id, friendly_name, factor_type, status) VALUES ($1, 'Authenticator', 'totp', $2)`,
    [userId, status],
  )
}

async function seedOwner(): Promise<{ owner: string; companyId: string }> {
  const owner = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  await insertCompanyMember({ companyId, userId: owner, role: 'owner' })
  return { owner, companyId }
}

/** A live key of the owner's, written outside RLS like the app's mint path. */
async function seedKey(owner: string, companyId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, 'gnubok_sk_mfa00000', 'Skript', ARRAY['companies:read'])
     RETURNING id`,
    [owner, companyId, sha256(randomUUID())],
  )
  return rows[0]!.id
}

function insertOwnKey(client: PoolClient, owner: string, companyId: string) {
  return client.query<{ id: string }>(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, 'gnubok_sk_attacker', 'attacker', ARRAY['bookkeeping:write'])
     RETURNING id`,
    [owner, companyId, sha256(`attacker-chosen-${randomUUID()}`)],
  )
}

describe('api_keys require an MFA-assured session (pg)', () => {
  it('ships two restrictive policies for INSERT and UPDATE on authenticated, and a definer helper anon cannot call', async () => {
    const { rows: policies } = await getPool().query<{ policyname: string; permissive: string; cmd: string; roles: string }>(
      `SELECT policyname, permissive, cmd, roles::text AS roles
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'api_keys' AND permissive = 'RESTRICTIVE'
        ORDER BY policyname`,
    )
    expect(policies).toEqual([
      { policyname: 'api_keys_insert_requires_mfa', permissive: 'RESTRICTIVE', cmd: 'INSERT', roles: '{authenticated}' },
      { policyname: 'api_keys_update_requires_mfa', permissive: 'RESTRICTIVE', cmd: 'UPDATE', roles: '{authenticated}' },
    ])

    const { rows: fn } = await getPool().query<{
      definer: boolean
      config: string[] | null
      anon: boolean
      auth: boolean
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
         FROM pg_proc p
        WHERE p.oid = 'public.session_is_mfa_assured()'::regprocedure`,
    )
    expect(fn).toEqual([{ definer: true, config: ['search_path=""'], anon: false, auth: true }])

    // The reason the helper is a definer: a user session cannot read the
    // factor table itself.
    const { rows: grant } = await getPool().query<{ can: boolean }>(
      `SELECT has_table_privilege('authenticated', 'auth.mfa_factors', 'SELECT') AS can`,
    )
    expect(grant[0]!.can).toBe(false)
  })

  it('refuses an AAL1 session of a user with a verified factor minting a key (the attack)', async () => {
    const { owner, companyId } = await seedOwner()
    await enrolFactor(owner)

    await expect(withSession(owner, 'aal1', (client) => insertOwnKey(client, owner, companyId))).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/api_keys_insert_requires_mfa/),
    })

    const { rows } = await getPool().query(`SELECT 1 FROM public.api_keys WHERE user_id = $1`, [owner])
    expect(rows).toHaveLength(0)
  })

  it('refuses an AAL1 session of a user with a verified factor changing a live key, and leaves the row as it was', async () => {
    const { owner, companyId } = await seedOwner()
    await enrolFactor(owner)
    const keyId = await seedKey(owner, companyId)
    const revokedId = await seedKey(owner, companyId)
    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [revokedId])

    for (const [id, set] of [
      [keyId, `scopes = ARRAY['companies:read', 'bookkeeping:write', 'pending_operations:approve']`],
      [keyId, `unattended_commit_limit = 1000000`],
      [keyId, `rate_limit_rpm = 100000`],
      // Bringing back a revoked (say, leaked) key is the change that matters most.
      [revokedId, `revoked_at = NULL`],
    ] as const) {
      await expect(
        withSession(owner, 'aal1', (client) => client.query(`UPDATE public.api_keys SET ${set} WHERE id = $1`, [id])),
        set,
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/api_keys_update_requires_mfa/) })
    }

    const { rows } = await getPool().query<{ id: string; scopes: string[]; unattended_commit_limit: string | null; revoked: boolean }>(
      `SELECT id, scopes, unattended_commit_limit, revoked_at IS NOT NULL AS revoked
         FROM public.api_keys WHERE id = ANY($1::uuid[]) ORDER BY revoked`,
      [[keyId, revokedId]],
    )
    expect(rows).toEqual([
      { id: keyId, scopes: ['companies:read'], unattended_commit_limit: null, revoked: false },
      { id: revokedId, scopes: ['companies:read'], unattended_commit_limit: null, revoked: true },
    ])
  })

  it('still lets an AAL1 session revoke a key: a revoked row never authenticates again', async () => {
    const { owner, companyId } = await seedOwner()
    await enrolFactor(owner)
    const keyId = await seedKey(owner, companyId)

    const res = await withSession(owner, 'aal1', (client) =>
      client.query(
        `UPDATE public.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [keyId],
      ),
    )
    expect(res.rows).toEqual([{ id: keyId }])
  })

  it('lets an AAL2 session of a user with a verified factor mint and change keys', async () => {
    const { owner, companyId } = await seedOwner()
    await enrolFactor(owner)
    const keyId = await seedKey(owner, companyId)

    await withSession(owner, 'aal2', async (client) => {
      const inserted = await insertOwnKey(client, owner, companyId)
      expect(inserted.rows).toHaveLength(1)
      const updated = await client.query(
        `UPDATE public.api_keys SET unattended_commit_limit = 5000 WHERE id = $1 RETURNING id`,
        [keyId],
      )
      expect(updated.rows).toEqual([{ id: keyId }])
    })
  })

  it('leaves users without a verified factor as they were, an unverified enrolment included', async () => {
    for (const status of [null, 'unverified'] as const) {
      const { owner, companyId } = await seedOwner()
      if (status) await enrolFactor(owner, status)
      const keyId = await seedKey(owner, companyId)

      await withSession(owner, 'aal1', async (client) => {
        const inserted = await insertOwnKey(client, owner, companyId)
        expect(inserted.rows, String(status)).toHaveLength(1)
        const updated = await client.query(
          `UPDATE public.api_keys SET unattended_commit_limit = 5000 WHERE id = $1 RETURNING id`,
          [keyId],
        )
        expect(updated.rows, String(status)).toEqual([{ id: keyId }])
      })
    }
  })

  it('keeps the service-role mint path working for a user with a verified factor', async () => {
    const { owner, companyId } = await seedOwner()
    await enrolFactor(owner)

    // The settings route and the MCP OAuth token route both mint through this
    // RPC on the service client, where RLS does not apply.
    const created = await runAsServiceRole((client) =>
      client.query<{ id: string }>(
        `SELECT public.create_api_key_with_allowlist(
           $1, $2, $3, 'gnubok_sk_svc00000', 'Skript', ARRAY['companies:read'],
           'live', NULL, NULL, NULL, NULL, NULL, NULL
         ) AS id`,
        [owner, companyId, sha256(randomUUID())],
      ),
    )
    const keyId = created.rows[0]!.id
    expect(keyId).toEqual(expect.any(String))

    const updated = await runAsServiceRole((client) =>
      client.query(`UPDATE public.api_keys SET unattended_commit_limit = 2500 WHERE id = $1 RETURNING id`, [keyId]),
    )
    expect(updated.rows).toEqual([{ id: keyId }])
  })
})
