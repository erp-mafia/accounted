import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20260923160100_api_key_companies.
 *
 * Locks in:
 *   - The table shape: composite primary key, both FKs ON DELETE CASCADE, the
 *     company_id index, RLS enabled with NO policies, and no privileges for
 *     anon / authenticated (service role only).
 *   - Deleting the api_keys row removes its allowlist rows.
 *   - validate_and_increment_api_key returns allowed_company_ids NULL for a
 *     key without rows (today's behaviour: every membership is reachable) and
 *     the listed ids, in created_at order, for a restricted key.
 *   - A restricted key whose stored default company is outside its allowlist
 *     answers with the first allowed company as company_id, so the default is
 *     always reachable.
 *   - The membership rule still refuses a key whose user has left the
 *     company: no row comes back, restricted or not.
 *
 * Inserts go through the pool (superuser, RLS-bypassing): the RPC is
 * SECURITY DEFINER and the only reader of the table, so this is a schema and
 * function test, not an RLS-policy test.
 */

async function insertApiKey(params: {
  userId: string
  companyId: string | null
}): Promise<{ id: string; keyHash: string }> {
  const id = randomUUID()
  // key_hash is unique: a fresh random hash per key keeps reruns independent.
  const keyHash = randomUUID().replace(/-/g, '').padEnd(64, '0')
  await getPool().query(
    `INSERT INTO public.api_keys
       (id, user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'pg-real allowlist key', $5)`,
    [id, params.userId, params.companyId, keyHash, ['companies:read']],
  )
  return { id, keyHash }
}

async function allow(apiKeyId: string, companyId: string, createdAt?: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.api_key_companies (api_key_id, company_id, created_at)
     VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
    [apiKeyId, companyId, createdAt ?? null],
  )
}

interface ValidateRow {
  user_id: string
  company_id: string | null
  api_key_id: string
  rate_limited: boolean
  allowed_company_ids: string[] | null
}

async function validate(keyHash: string): Promise<ValidateRow[]> {
  const { rows } = await getPool().query<ValidateRow>(
    `SELECT user_id, company_id, api_key_id, rate_limited, allowed_company_ids
     FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

describe('api_key_companies (migration 20260923160100): shape', () => {
  it('has the expected columns and a composite primary key', async () => {
    const { rows } = await getPool().query<{
      column_name: string
      data_type: string
      is_nullable: string
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'api_key_companies'
       ORDER BY ordinal_position`,
    )
    expect(rows).toEqual([
      { column_name: 'api_key_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'company_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ])

    const pk = await getPool().query<{ columns: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_constraint c
       JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = 'public.api_key_companies'::regclass AND c.contype = 'p'`,
    )
    expect(pk.rows[0]?.columns).toEqual(['api_key_id', 'company_id'])
  })

  it('cascades from both api_keys and companies and indexes company_id', async () => {
    const { rows } = await getPool().query<{
      column: string
      foreign_table: string
      on_delete: string
    }>(
      `SELECT a.attname AS column,
              c.confrelid::regclass::text AS foreign_table,
              c.confdeltype AS on_delete
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.api_key_companies'::regclass AND c.contype = 'f'
       ORDER BY a.attname`,
    )
    // confdeltype 'c' = CASCADE.
    expect(rows).toEqual([
      { column: 'api_key_id', foreign_table: 'api_keys', on_delete: 'c' },
      { column: 'company_id', foreign_table: 'companies', on_delete: 'c' },
    ])

    const index = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'api_key_companies'
         AND indexname = 'idx_api_key_companies_company_id'`,
    )
    expect(index.rows).toHaveLength(1)
    expect(index.rows[0]!.indexdef).toMatch(/\(company_id\)/)
  })

  it('has RLS enabled, no policies, and no privileges for anon or authenticated', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_key_companies'::regclass`,
    )
    expect(rls.rows[0]?.relrowsecurity).toBe(true)

    const policies = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'api_key_companies'`,
    )
    expect(policies.rows[0]?.n).toBe('0')

    const grants = await getPool().query<{ role: string; can_select: boolean; can_insert: boolean }>(
      `SELECT r.role,
              has_table_privilege(r.role, 'public.api_key_companies', 'SELECT') AS can_select,
              has_table_privilege(r.role, 'public.api_key_companies', 'INSERT') AS can_insert
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
       ORDER BY r.role`,
    )
    expect(grants.rows).toEqual([
      { role: 'anon', can_select: false, can_insert: false },
      { role: 'authenticated', can_select: false, can_insert: false },
      { role: 'service_role', can_select: true, can_insert: true },
    ])
  })

  it('drops the allowlist rows when the api_keys row is deleted', async () => {
    const { userId, companyId } = await seedCompany()
    const key = await insertApiKey({ userId, companyId })
    await allow(key.id, companyId)

    const before = await getPool().query(
      `SELECT 1 FROM public.api_key_companies WHERE api_key_id = $1`,
      [key.id],
    )
    expect(before.rowCount).toBe(1)

    await getPool().query(`DELETE FROM public.api_keys WHERE id = $1`, [key.id])

    const after = await getPool().query(
      `SELECT 1 FROM public.api_key_companies WHERE api_key_id = $1`,
      [key.id],
    )
    expect(after.rowCount).toBe(0)
  })
})

describe('validate_and_increment_api_key: allowed_company_ids', () => {
  it('returns NULL for a key without allowlist rows (every membership reachable)', async () => {
    const { userId, companyId } = await seedCompany()
    const key = await insertApiKey({ userId, companyId })

    const rows = await validate(key.keyHash)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: userId,
      company_id: companyId,
      api_key_id: key.id,
      rate_limited: false,
      allowed_company_ids: null,
    })
  })

  it('returns the listed companies in created_at order for a restricted key', async () => {
    const { userId, companyId } = await seedCompany()
    const second = await insertCompany({ createdBy: userId, name: 'Second AB' })
    await insertCompanyMember({ companyId: second, userId, role: 'admin' })
    const key = await insertApiKey({ userId, companyId })
    // Listed second but created earlier: created_at decides the order.
    await allow(key.id, second, '2026-01-01T00:00:00Z')
    await allow(key.id, companyId, '2026-02-01T00:00:00Z')

    const rows = await validate(key.keyHash)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(companyId)
    expect(rows[0]!.allowed_company_ids).toEqual([second, companyId])
  })

  it('swaps a default company outside the allowlist for the first allowed one', async () => {
    const { userId, companyId } = await seedCompany()
    const allowedLate = await insertCompany({ createdBy: userId, name: 'Allowed late AB' })
    const allowedEarly = await insertCompany({ createdBy: userId, name: 'Allowed early AB' })
    await insertCompanyMember({ companyId: allowedLate, userId, role: 'owner' })
    await insertCompanyMember({ companyId: allowedEarly, userId, role: 'owner' })
    // Stored default is the seeded company, which the allowlist does not name.
    const key = await insertApiKey({ userId, companyId })
    await allow(key.id, allowedLate, '2026-03-01T00:00:00Z')
    await allow(key.id, allowedEarly, '2026-01-01T00:00:00Z')

    const rows = await validate(key.keyHash)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(allowedEarly)
    expect(rows[0]!.allowed_company_ids).toEqual([allowedEarly, allowedLate])

    // The swap is computed per call, never written back to api_keys.
    const stored = await getPool().query<{ company_id: string }>(
      `SELECT company_id FROM public.api_keys WHERE id = $1`,
      [key.id],
    )
    expect(stored.rows[0]?.company_id).toBe(companyId)
  })

  it('skips an allowed company the user has left when picking the swapped default', async () => {
    const { userId, companyId } = await seedCompany()
    const left = await insertCompany({ createdBy: userId, name: 'Left AB' })
    const stillIn = await insertCompany({ createdBy: userId, name: 'Still in AB' })
    await insertCompanyMember({ companyId: stillIn, userId, role: 'member' })
    const key = await insertApiKey({ userId, companyId })
    await allow(key.id, left, '2026-01-01T00:00:00Z')
    await allow(key.id, stillIn, '2026-02-01T00:00:00Z')

    const rows = await validate(key.keyHash)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(stillIn)
  })

  it('refuses a restricted key whose allowlist names no company the user still belongs to', async () => {
    const { userId, companyId } = await seedCompany()
    const stranger = await seedCompany()
    const key = await insertApiKey({ userId, companyId })
    await allow(key.id, stranger.companyId)

    expect(await validate(key.keyHash)).toEqual([])
  })

  it('still refuses a key whose user left its (allowed) default company', async () => {
    const { userId, companyId } = await seedCompany()
    const restricted = await insertApiKey({ userId, companyId })
    await allow(restricted.id, companyId)
    const unrestricted = await insertApiKey({ userId, companyId })

    // Both validate while the membership exists.
    expect(await validate(restricted.keyHash)).toHaveLength(1)
    expect(await validate(unrestricted.keyHash)).toHaveLength(1)

    await getPool().query(
      `DELETE FROM public.company_members WHERE user_id = $1 AND company_id = $2`,
      [userId, companyId],
    )

    expect(await validate(restricted.keyHash)).toEqual([])
    expect(await validate(unrestricted.keyHash)).toEqual([])
  })

  it('binds a company-less restricted key to its first allowed live membership', async () => {
    const { userId, companyId } = await seedCompany()
    const key = await insertApiKey({ userId, companyId: null })
    await allow(key.id, companyId)

    const rows = await validate(key.keyHash)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(companyId)
    expect(rows[0]!.allowed_company_ids).toEqual([companyId])
  })
})
