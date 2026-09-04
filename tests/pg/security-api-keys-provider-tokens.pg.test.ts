import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

/**
 * Migration 20260902090000: the critical items of the 2026-09-01 security
 * audit.
 *
 *  - api_keys INSERT binds user_id to the caller again (an admin could forge
 *    a key for any co-member and act as them everywhere).
 *  - api_keys SELECT is own-keys-or-admin (viewers could read every hash).
 *  - identity/credential columns are frozen against JWT-session UPDATEs.
 *  - rotate_mcp_refresh_token / validate_and_increment_api_key are
 *    service_role only (hash-as-bearer takeover).
 *  - validate_and_increment_api_key fails closed once the key's user is no
 *    longer a member of the key's company.
 *  - provider_consent_tokens / provider_otc are service_role only (the DELETE
 *    policy had collapsed to "caller has any team row").
 */

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function seedCompanyWithAdmin() {
  const owner = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  await insertCompanyMember({ companyId, userId: owner, role: 'owner' })
  const admin = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: admin, role: 'admin' })
  return { owner, admin, companyId }
}

describe('security audit: api_keys identity binding (pg)', () => {
  it('lets an admin mint a key for themselves', async () => {
    const { admin, companyId } = await seedCompanyWithAdmin()
    await withUserContext(admin, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
         VALUES ($1, $2, $3, 'gnubok_sk_aaaaaaaa', 'own', ARRAY['companies:read'])
         RETURNING id`,
        [admin, companyId, sha256(randomUUID())],
      )
      expect(res.rows).toHaveLength(1)
    })
  })

  it('refuses an admin minting a key that impersonates a co-member', async () => {
    const { owner, admin, companyId } = await seedCompanyWithAdmin()
    await expect(
      withUserContext(admin, (client) =>
        client.query(
          `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
           VALUES ($1, $2, $3, 'gnubok_sk_bbbbbbbb', 'forged', ARRAY['bookkeeping:write'])`,
          [owner, companyId, sha256(randomUUID())],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('refuses a JWT session rewriting identity or credential columns', async () => {
    const { owner, admin, companyId } = await seedCompanyWithAdmin()
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, 'gnubok_sk_cccccccc', 'victim', ARRAY['companies:read'])
       RETURNING id`,
      [owner, companyId, sha256(randomUUID())],
    )
    const keyId = rows[0]!.id

    for (const set of [
      `user_id = '${admin}'`,
      `key_hash = '${sha256('attacker')}'`,
      `refresh_token_hash = '${sha256('rt')}'`,
      `mode = 'test'`,
    ]) {
      await expect(
        withUserContext(admin, (client) =>
          client.query(`UPDATE public.api_keys SET ${set} WHERE id = $1`, [keyId]),
        ),
      ).rejects.toMatchObject({ code: '42501' })
    }

    // Revoking stays possible for admins: that is the settings route's job.
    await withUserContext(admin, async (client) => {
      const res = await client.query(
        `UPDATE public.api_keys SET revoked_at = now() WHERE id = $1 RETURNING id`,
        [keyId],
      )
      expect(res.rows).toHaveLength(1)
    })
  })

  it('hides other members keys from non-admins and shows them to admins', async () => {
    const { owner, admin, companyId } = await seedCompanyWithAdmin()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, 'gnubok_sk_dddddddd', 'owner key', ARRAY['companies:read'])`,
      [owner, companyId, sha256(randomUUID())],
    )

    await withUserContext(viewer, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.api_keys WHERE company_id = $1`,
        [companyId],
      )
      expect(res.rows).toHaveLength(0)
    })
    await withUserContext(admin, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.api_keys WHERE company_id = $1`,
        [companyId],
      )
      expect(res.rows.length).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('security audit: hash-as-bearer RPCs (pg)', () => {
  it('denies EXECUTE on rotate_mcp_refresh_token and validate_and_increment_api_key to anon and authenticated', async () => {
    const { rows } = await getPool().query<{ fn: string; anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT p.proname AS fn,
              has_function_privilege('anon', p.oid, 'execute') AS anon,
              has_function_privilege('authenticated', p.oid, 'execute') AS auth,
              has_function_privilege('service_role', p.oid, 'execute') AS svc
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('rotate_mcp_refresh_token', 'validate_and_increment_api_key')`,
    )
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.anon, r.fn).toBe(false)
      expect(r.auth, r.fn).toBe(false)
      expect(r.svc, r.fn).toBe(true)
    }
  })

  it('validate_and_increment_api_key returns no row once the key user left the company', async () => {
    const { owner, companyId } = await seedCompanyWithAdmin()
    const key = `gnubok_sk_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, 'gnubok_sk_eeeeeeee', 'k', ARRAY['companies:read'])`,
      [owner, companyId, sha256(key)],
    )

    const live = await runAsServiceRole((client) =>
      client.query(`SELECT * FROM public.validate_and_increment_api_key($1)`, [sha256(key)]),
    )
    expect(live.rows).toHaveLength(1)

    await getPool().query(
      `DELETE FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, owner],
    )
    const stale = await runAsServiceRole((client) =>
      client.query(`SELECT * FROM public.validate_and_increment_api_key($1)`, [sha256(key)]),
    )
    expect(stale.rows).toHaveLength(0)
  })

  it('keeps validating company-less (lazy-bind) keys', async () => {
    const user = await insertAuthUser()
    const key = `gnubok_sk_${randomUUID()}`
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, NULL, $2, 'gnubok_sk_ffffffff', 'unbound', ARRAY['companies:read'])`,
      [user, sha256(key)],
    )
    const res = await runAsServiceRole((client) =>
      client.query(`SELECT * FROM public.validate_and_increment_api_key($1)`, [sha256(key)]),
    )
    expect(res.rows).toHaveLength(1)
  })
})

describe('security audit: provider token tables are service_role only (pg)', () => {
  async function seedConsentWithToken() {
    const { owner, companyId } = await seedCompanyWithAdmin()
    const consent = await getPool().query<{ id: string }>(
      `INSERT INTO public.provider_consents (company_id, name, status, provider)
       VALUES ($1, 'Fortnox', 1, 'fortnox') RETURNING id`,
      [companyId],
    )
    const consentId = consent.rows[0]!.id
    await getPool().query(
      `INSERT INTO public.provider_consent_tokens (consent_id, provider, access_token, refresh_token, token_expires_at)
       VALUES ($1, 'fortnox', 'access-secret', 'refresh-secret', now() + interval '1 hour')`,
      [consentId],
    )
    return { owner, companyId, consentId }
  }

  it('an unrelated user with a team row can no longer delete anyone tokens', async () => {
    const { consentId } = await seedConsentWithToken()
    const outsider = await insertAuthUser()
    const team = await getPool().query<{ id: string }>(
      `INSERT INTO public.teams (name, created_by) VALUES ('Personal', $1) RETURNING id`,
      [outsider],
    )
    await getPool().query(
      `INSERT INTO public.team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [team.rows[0]!.id, outsider],
    )

    await expect(
      withUserContext(outsider, (client) =>
        client.query(`DELETE FROM public.provider_consent_tokens WHERE consent_id = $1`, [consentId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const { rows } = await getPool().query(
      `SELECT 1 FROM public.provider_consent_tokens WHERE consent_id = $1`,
      [consentId],
    )
    expect(rows).toHaveLength(1)
  })

  it('a company member cannot read the plaintext tokens of their own company', async () => {
    const { owner, consentId } = await seedConsentWithToken()
    await expect(
      withUserContext(owner, (client) =>
        client.query(`SELECT access_token FROM public.provider_consent_tokens WHERE consent_id = $1`, [
          consentId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('the service role still reads and deletes them', async () => {
    const { consentId } = await seedConsentWithToken()
    const read = await runAsServiceRole((client) =>
      client.query(`SELECT access_token FROM public.provider_consent_tokens WHERE consent_id = $1`, [
        consentId,
      ]),
    )
    expect(read.rows).toHaveLength(1)
    const del = await runAsServiceRole((client) =>
      client.query(`DELETE FROM public.provider_consent_tokens WHERE consent_id = $1 RETURNING consent_id`, [
        consentId,
      ]),
    )
    expect(del.rows).toHaveLength(1)
  })
})
