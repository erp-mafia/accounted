import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration
 * 20260923190000_api_key_allowlist_fail_closed_on_company_delete.
 *
 * api_key_companies.company_id is ON DELETE CASCADE and "no rows" means
 * "every company the user belongs to". Locks in that a company deletion which
 * empties a key's allowlist revokes the key instead of widening it, that
 * deleting one of several allowlisted companies keeps the key restricted to
 * the rest, and that the explicit "all companies" edit
 * (replace_api_key_allowlist with NULL) still clears the list without
 * revoking.
 *
 * The key's default company (api_keys.company_id, itself ON DELETE CASCADE)
 * is deliberately a company outside the allowlist: that is the shape where
 * the key survives the company deletion and the widening was reachable.
 */

async function insertApiKey(userId: string, companyId: string): Promise<{ id: string; keyHash: string }> {
  const id = randomUUID()
  const keyHash = randomUUID().replace(/-/g, '').padEnd(64, '0')
  await getPool().query(
    `INSERT INTO public.api_keys
       (id, user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'pg-real fail-closed key', $5)`,
    [id, userId, companyId, keyHash, ['companies:read']],
  )
  return { id, keyHash }
}

async function allow(apiKeyId: string, companyId: string, createdAt: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.api_key_companies (api_key_id, company_id, created_at)
     VALUES ($1, $2, $3::timestamptz)`,
    [apiKeyId, companyId, createdAt],
  )
}

async function deleteCompany(companyId: string): Promise<void> {
  await getPool().query(`DELETE FROM public.companies WHERE id = $1`, [companyId])
}

async function revokedAt(apiKeyId: string): Promise<Date | null> {
  const { rows } = await getPool().query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM public.api_keys WHERE id = $1`,
    [apiKeyId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!.revoked_at
}

async function validate(
  keyHash: string,
): Promise<Array<{ company_id: string | null; allowed_company_ids: string[] | null }>> {
  const { rows } = await getPool().query<{
    company_id: string | null
    allowed_company_ids: string[] | null
  }>(
    `SELECT company_id, allowed_company_ids FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

/** A user with a default company plus two more companies, all live memberships. */
async function seedUserWithThreeCompanies(): Promise<{
  userId: string
  defaultCompany: string
  b: string
  c: string
}> {
  const { userId, companyId: defaultCompany } = await seedCompany()
  const b = await insertCompany({ createdBy: userId, name: 'Allowed B AB' })
  await insertCompanyMember({ companyId: b, userId, role: 'owner' })
  const c = await insertCompany({ createdBy: userId, name: 'Allowed C AB' })
  await insertCompanyMember({ companyId: c, userId, role: 'owner' })
  return { userId, defaultCompany, b, c }
}

describe('api_key_companies fail closed on company delete (migration 20260923190000)', () => {
  it('revokes the key when its only allowlisted company is deleted', async () => {
    const { userId, defaultCompany, b } = await seedUserWithThreeCompanies()
    const key = await insertApiKey(userId, defaultCompany)
    await allow(key.id, b, '2026-09-23T10:00:00Z')

    // Before: restricted to b.
    expect(await validate(key.keyHash)).toEqual([
      { company_id: b, allowed_company_ids: [b] },
    ])

    await deleteCompany(b)

    expect(await revokedAt(key.id)).toBeInstanceOf(Date)
    // Revoked: no row, the caller answers 401. Never "every company".
    expect(await validate(key.keyHash)).toEqual([])
  })

  it('keeps the key restricted to the remaining company when one of two is deleted', async () => {
    const { userId, defaultCompany, b, c } = await seedUserWithThreeCompanies()
    const key = await insertApiKey(userId, defaultCompany)
    await allow(key.id, b, '2026-09-23T10:00:00Z')
    await allow(key.id, c, '2026-09-23T10:01:00Z')

    await deleteCompany(b)

    expect(await revokedAt(key.id)).toBeNull()
    expect(await validate(key.keyHash)).toEqual([
      { company_id: c, allowed_company_ids: [c] },
    ])
  })

  it('does not revoke when the allowlist is cleared explicitly (the "all companies" edit)', async () => {
    const { userId, defaultCompany, b } = await seedUserWithThreeCompanies()
    const key = await insertApiKey(userId, defaultCompany)
    await allow(key.id, b, '2026-09-23T10:00:00Z')

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT public.replace_api_key_allowlist($1, NULL) AS n`,
      [key.id],
    )
    expect(rows[0]!.n).toBe(0)

    expect(await revokedAt(key.id)).toBeNull()
    expect(await validate(key.keyHash)).toEqual([
      { company_id: defaultCompany, allowed_company_ids: null },
    ])
  })

  it('does not revoke when an explicit replace swaps the only company for another', async () => {
    const { userId, defaultCompany, b, c } = await seedUserWithThreeCompanies()
    const key = await insertApiKey(userId, defaultCompany)
    await allow(key.id, b, '2026-09-23T10:00:00Z')

    await getPool().query(`SELECT public.replace_api_key_allowlist($1, $2::uuid[])`, [key.id, [c]])

    expect(await revokedAt(key.id)).toBeNull()
    expect(await validate(key.keyHash)).toEqual([
      { company_id: c, allowed_company_ids: [c] },
    ])
  })

  it('leaves an unrestricted key alone when one of its companies is deleted', async () => {
    const { userId, defaultCompany, b } = await seedUserWithThreeCompanies()
    const key = await insertApiKey(userId, defaultCompany)

    await deleteCompany(b)

    expect(await revokedAt(key.id)).toBeNull()
    expect(await validate(key.keyHash)).toEqual([
      { company_id: defaultCompany, allowed_company_ids: null },
    ])
  })

  it('deleting the key itself cascades through the trigger without error', async () => {
    const { userId, defaultCompany, b } = await seedUserWithThreeCompanies()
    const key = await insertApiKey(userId, defaultCompany)
    await allow(key.id, b, '2026-09-23T10:00:00Z')

    await getPool().query(`DELETE FROM public.api_keys WHERE id = $1`, [key.id])

    const { rows } = await getPool().query(
      `SELECT 1 FROM public.api_key_companies WHERE api_key_id = $1`,
      [key.id],
    )
    expect(rows).toEqual([])
  })

  it('is SECURITY DEFINER with a fixed search_path and not executable by anon/authenticated', async () => {
    const { rows } = await getPool().query<{
      prosecdef: boolean
      proconfig: string[] | null
      anon: boolean
      authed: boolean
    }>(
      `SELECT p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
       FROM pg_proc p
       WHERE p.oid = 'public.revoke_api_key_on_emptied_allowlist()'::regprocedure`,
    )
    expect(rows[0]).toMatchObject({ prosecdef: true, anon: false, authed: false })
    expect(rows[0]!.proconfig).toContain('search_path=public')
  })
})
