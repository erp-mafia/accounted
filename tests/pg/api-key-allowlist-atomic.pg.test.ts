import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20260923160200_api_key_allowlist_atomic.
 *
 * Locks in:
 *   - create_api_key_with_allowlist writes the api_keys row and its
 *     api_key_companies rows in one transaction: a valid list yields both, a
 *     list with one company the user is not a member of yields NOTHING (no
 *     key row, no allowlist rows), and a default company outside the list is
 *     refused the same way.
 *   - NULL / empty list creates an unrestricted key (no rows); NULL name and
 *     mode take the column defaults.
 *   - replace_api_key_allowlist swaps the set atomically: a bad id leaves the
 *     old set intact, NULL and [] clear it, a missing or revoked key raises.
 *   - Both functions are EXECUTE-denied to anon and authenticated and
 *     granted to service_role.
 *
 * Calls go through the pool (superuser): both functions are SECURITY DEFINER
 * and service-role only, so this is a function test, not an RLS-policy test.
 */

const CREATE_SIGNATURE =
  'public.create_api_key_with_allowlist(uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[])'
const REPLACE_SIGNATURE = 'public.replace_api_key_allowlist(uuid, uuid[])'

function freshHash(): string {
  // key_hash is unique: a fresh random hash per key keeps reruns independent.
  return randomUUID().replace(/-/g, '').padEnd(64, '0')
}

interface CreateParams {
  userId: string
  companyId: string | null
  keyHash?: string
  name?: string | null
  scopes?: string[]
  mode?: string | null
  client?: string | null
  refreshTokenHash?: string | null
  sodAcknowledgedAt?: string | null
  sodAcknowledgedBy?: string | null
  unattendedCommitLimit?: number | null
  companyIds: string[] | null
}

async function createKey(params: CreateParams): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT public.create_api_key_with_allowlist(
       $1, $2, $3, 'gnubok_sk_test', $4, $5, $6, $7, $8, $9, $10, $11, $12
     ) AS id`,
    [
      params.userId,
      params.companyId,
      params.keyHash ?? freshHash(),
      params.name === undefined ? 'pg-real atomic key' : params.name,
      params.scopes ?? ['companies:read'],
      params.mode === undefined ? 'live' : params.mode,
      params.client ?? null,
      params.refreshTokenHash ?? null,
      params.sodAcknowledgedAt ?? null,
      params.sodAcknowledgedBy ?? null,
      params.unattendedCommitLimit ?? null,
      params.companyIds,
    ],
  )
  return rows[0]!.id
}

async function replaceAllowlist(apiKeyId: string, companyIds: string[] | null): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT public.replace_api_key_allowlist($1, $2) AS n`,
    [apiKeyId, companyIds],
  )
  return rows[0]!.n
}

async function allowlistOf(apiKeyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ company_id: string }>(
    `SELECT company_id FROM public.api_key_companies
     WHERE api_key_id = $1
     ORDER BY created_at, company_id`,
    [apiKeyId],
  )
  return rows.map((row) => row.company_id)
}

async function keysWithHash(keyHash: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.api_keys WHERE key_hash = $1`,
    [keyHash],
  )
  return Number(rows[0]!.n)
}

describe('create_api_key_with_allowlist (migration 20260923160200)', () => {
  it('writes the key row and one allowlist row per company for a valid list', async () => {
    const { userId, companyId } = await seedCompany()
    const second = await insertCompany({ createdBy: userId, name: 'Second AB' })
    await insertCompanyMember({ companyId: second, userId, role: 'admin' })
    const keyHash = freshHash()

    const keyId = await createKey({
      userId,
      companyId,
      keyHash,
      name: 'Restricted key',
      scopes: ['companies:read', 'reports:read'],
      mode: 'test',
      client: 'claude',
      refreshTokenHash: 'refresh-hash',
      sodAcknowledgedAt: '2026-09-19T10:00:00Z',
      sodAcknowledgedBy: userId,
      unattendedCommitLimit: 2500,
      companyIds: [companyId, second, companyId], // duplicate collapses
    })

    const { rows } = await getPool().query(
      `SELECT user_id, company_id, key_hash, key_prefix, name, scopes, mode, client,
              refresh_token_hash, sod_acknowledged_at, sod_acknowledged_by,
              unattended_commit_limit, rate_limit_rpm, request_count, revoked_at
       FROM public.api_keys WHERE id = $1`,
      [keyId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: userId,
      company_id: companyId,
      key_hash: keyHash,
      key_prefix: 'gnubok_sk_test',
      name: 'Restricted key',
      scopes: ['companies:read', 'reports:read'],
      mode: 'test',
      client: 'claude',
      refresh_token_hash: 'refresh-hash',
      sod_acknowledged_by: userId,
      unattended_commit_limit: '2500.00',
      rate_limit_rpm: 100,
      request_count: 0,
      revoked_at: null,
    })
    expect(rows[0]!.sod_acknowledged_at).toBeInstanceOf(Date)

    expect((await allowlistOf(keyId)).sort()).toEqual([companyId, second].sort())

    // The validation RPC sees the same list: the two writes are one unit.
    const validated = await getPool().query<{ allowed_company_ids: string[] | null }>(
      `SELECT allowed_company_ids FROM public.validate_and_increment_api_key($1)`,
      [keyHash],
    )
    expect(validated.rows[0]!.allowed_company_ids!.sort()).toEqual([companyId, second].sort())
  })

  it('writes NOTHING when one listed company is not a live membership of the user', async () => {
    const { userId, companyId } = await seedCompany()
    const stranger = await seedCompany()
    const keyHash = freshHash()

    await expect(
      createKey({ userId, companyId, keyHash, companyIds: [companyId, stranger.companyId] }),
    ).rejects.toThrow(/not a live member/)

    // No key row: the api_keys insert rolled back with the allowlist.
    expect(await keysWithHash(keyHash)).toBe(0)
    const rows = await getPool().query(
      `SELECT 1 FROM public.api_key_companies WHERE company_id = $1 OR company_id = $2`,
      [companyId, stranger.companyId],
    )
    expect(rows.rowCount).toBe(0)
  })

  it('treats an archived company as not a membership', async () => {
    const { userId, companyId } = await seedCompany()
    const archived = await insertCompany({ createdBy: userId, name: 'Archived AB' })
    await insertCompanyMember({ companyId: archived, userId, role: 'owner' })
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [archived])
    const keyHash = freshHash()

    await expect(
      createKey({ userId, companyId, keyHash, companyIds: [companyId, archived] }),
    ).rejects.toThrow(/not a live member/)
    expect(await keysWithHash(keyHash)).toBe(0)
  })

  it('refuses a default company outside the allowlist and writes nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const second = await insertCompany({ createdBy: userId, name: 'Second AB' })
    await insertCompanyMember({ companyId: second, userId, role: 'owner' })
    const keyHash = freshHash()

    await expect(
      createKey({ userId, companyId, keyHash, companyIds: [second] }),
    ).rejects.toThrow(/default company .* is not in the allowlist/)
    expect(await keysWithHash(keyHash)).toBe(0)

    // A company-less key cannot be restricted either: no default to reach.
    const companylessHash = freshHash()
    await expect(
      createKey({ userId, companyId: null, keyHash: companylessHash, companyIds: [companyId] }),
    ).rejects.toThrow(/default company .* is not in the allowlist/)
    expect(await keysWithHash(companylessHash)).toBe(0)
  })

  it('creates an unrestricted key for NULL and for an empty list, with column defaults for NULL name and mode', async () => {
    const { userId, companyId } = await seedCompany()

    const nullList = await createKey({ userId, companyId, name: null, mode: null, companyIds: null })
    const emptyList = await createKey({ userId, companyId, companyIds: [] })

    expect(await allowlistOf(nullList)).toEqual([])
    expect(await allowlistOf(emptyList)).toEqual([])

    const { rows } = await getPool().query<{ name: string; mode: string; company_id: string }>(
      `SELECT name, mode, company_id FROM public.api_keys WHERE id = $1`,
      [nullList],
    )
    expect(rows[0]).toEqual({ name: 'Unnamed key', mode: 'live', company_id: companyId })
  })

  it('mints a company-less unrestricted key (OAuth lazy bind)', async () => {
    const { userId } = await seedCompany()
    const keyId = await createKey({ userId, companyId: null, companyIds: null })
    const { rows } = await getPool().query<{ company_id: string | null }>(
      `SELECT company_id FROM public.api_keys WHERE id = $1`,
      [keyId],
    )
    expect(rows[0]!.company_id).toBeNull()
    expect(await allowlistOf(keyId)).toEqual([])
  })
})

describe('replace_api_key_allowlist (migration 20260923160200)', () => {
  it('swaps the set: drops what is no longer listed, adds what is missing, returns the new size', async () => {
    const { userId, companyId } = await seedCompany()
    const second = await insertCompany({ createdBy: userId, name: 'Second AB' })
    const third = await insertCompany({ createdBy: userId, name: 'Third AB' })
    await insertCompanyMember({ companyId: second, userId, role: 'member' })
    await insertCompanyMember({ companyId: third, userId, role: 'member' })
    const keyId = await createKey({ userId, companyId, companyIds: [companyId, second] })

    const n = await replaceAllowlist(keyId, [companyId, third, third])

    expect(n).toBe(2)
    expect((await allowlistOf(keyId)).sort()).toEqual([companyId, third].sort())
  })

  it('leaves the old set intact when one new id is not a live membership', async () => {
    const { userId, companyId } = await seedCompany()
    const second = await insertCompany({ createdBy: userId, name: 'Second AB' })
    await insertCompanyMember({ companyId: second, userId, role: 'member' })
    const stranger = await seedCompany()
    const keyId = await createKey({ userId, companyId, companyIds: [companyId, second] })

    await expect(replaceAllowlist(keyId, [companyId, stranger.companyId])).rejects.toThrow(
      /not a live member/,
    )

    // Neither the prune nor the insert landed: second is still there, the
    // stranger never arrived.
    expect((await allowlistOf(keyId)).sort()).toEqual([companyId, second].sort())
  })

  it('clears every row for NULL and for an empty list (unrestricted)', async () => {
    const { userId, companyId } = await seedCompany()
    const keyId = await createKey({ userId, companyId, companyIds: [companyId] })

    expect(await replaceAllowlist(keyId, null)).toBe(0)
    expect(await allowlistOf(keyId)).toEqual([])

    expect(await replaceAllowlist(keyId, [companyId])).toBe(1)
    expect(await replaceAllowlist(keyId, [])).toBe(0)
    expect(await allowlistOf(keyId)).toEqual([])
  })

  it('validates against the key user, not any other member of the company', async () => {
    // The key belongs to userId; another user who owns a fourth company does
    // not make that company reachable for this key.
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    const keyId = await createKey({ userId, companyId, companyIds: [companyId] })

    await expect(replaceAllowlist(keyId, [companyId, other.companyId])).rejects.toThrow(
      /not a live member/,
    )
    expect(await allowlistOf(keyId)).toEqual([companyId])
  })

  it('raises for a key that does not exist and for a revoked key, touching nothing', async () => {
    const { userId, companyId } = await seedCompany()

    await expect(replaceAllowlist(randomUUID(), [companyId])).rejects.toThrow(
      /does not exist or is revoked/,
    )

    const keyId = await createKey({ userId, companyId, companyIds: [companyId] })
    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [keyId])

    await expect(replaceAllowlist(keyId, null)).rejects.toThrow(/does not exist or is revoked/)
    expect(await allowlistOf(keyId)).toEqual([companyId])
  })
})

describe('api key allowlist RPCs: privileges', () => {
  it('are EXECUTE-denied to anon and authenticated and granted to service_role', async () => {
    const { rows } = await getPool().query<{
      role: string
      can_create: boolean
      can_replace: boolean
    }>(
      `SELECT r.role,
              has_function_privilege(r.role, $1, 'EXECUTE') AS can_create,
              has_function_privilege(r.role, $2, 'EXECUTE') AS can_replace
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
       ORDER BY r.role`,
      [CREATE_SIGNATURE, REPLACE_SIGNATURE],
    )
    expect(rows).toEqual([
      { role: 'anon', can_create: false, can_replace: false },
      { role: 'authenticated', can_create: false, can_replace: false },
      { role: 'service_role', can_create: true, can_replace: true },
    ])
  })

  it('are SECURITY DEFINER with a fixed search_path', async () => {
    const { rows } = await getPool().query<{ proname: string; prosecdef: boolean; proconfig: string[] }>(
      `SELECT proname, prosecdef, proconfig
       FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('create_api_key_with_allowlist', 'replace_api_key_allowlist')
       ORDER BY proname`,
    )
    expect(rows).toEqual([
      { proname: 'create_api_key_with_allowlist', prosecdef: true, proconfig: ['search_path=public'] },
      { proname: 'replace_api_key_allowlist', prosecdef: true, proconfig: ['search_path=public'] },
    ])
  })
})
