import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20260928112724_api_key_companies_access_level.
 *
 * Locks in:
 *   - api_key_companies.access: NOT NULL, default 'write', CHECK read | write.
 *   - validate_and_increment_api_key returns read_only_company_ids: NULL for
 *     an unrestricted key and for a restricted key without read-only rows,
 *     else the read-only ids in allowlist order. A read-only company can be
 *     the key's default.
 *   - create_api_key_with_allowlist writes the levels in the same transaction
 *     as the key, keeps the old thirteen-parameter call working (every
 *     company at write), and writes NOTHING when read-only ids come with an
 *     unrestricted key or sit outside the allowlist.
 *   - replace_api_key_allowlist: NULL keeps existing levels and gives new
 *     companies write; an array sets levels exactly and an empty one lifts
 *     them; making a key with read-only companies unrestricted needs the
 *     explicit empty array; bad input leaves the old rows untouched.
 *
 * Calls go through the pool (superuser): every function here is SECURITY
 * DEFINER and service-role only, so this is a function test.
 */

function freshHash(): string {
  // key_hash is unique: a fresh random hash per key keeps reruns independent.
  return randomUUID().replace(/-/g, '').padEnd(64, '0')
}

async function createKey(params: {
  userId: string
  companyId: string | null
  keyHash?: string
  companyIds: string[] | null
  readOnlyCompanyIds?: string[] | null
}): Promise<string> {
  const args = [
    params.userId,
    params.companyId,
    params.keyHash ?? freshHash(),
    'gnubok_sk_test',
    'pg-real access key',
    ['companies:read', 'invoices:write'],
    'live',
    null,
    null,
    null,
    null,
    null,
    params.companyIds,
  ]
  // Omitting the fourteenth argument exercises the DEFAULT, i.e. exactly the
  // call every caller made before this migration.
  const sql =
    params.readOnlyCompanyIds === undefined
      ? `SELECT public.create_api_key_with_allowlist($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) AS id`
      : `SELECT public.create_api_key_with_allowlist($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS id`
  const { rows } = await getPool().query<{ id: string }>(
    sql,
    params.readOnlyCompanyIds === undefined ? args : [...args, params.readOnlyCompanyIds],
  )
  return rows[0]!.id
}

async function replaceAllowlist(
  apiKeyId: string,
  companyIds: string[] | null,
  readOnlyCompanyIds?: string[] | null,
): Promise<number> {
  const { rows } =
    readOnlyCompanyIds === undefined
      ? await getPool().query<{ n: number }>(
          `SELECT public.replace_api_key_allowlist($1, $2) AS n`,
          [apiKeyId, companyIds],
        )
      : await getPool().query<{ n: number }>(
          `SELECT public.replace_api_key_allowlist($1, $2, $3) AS n`,
          [apiKeyId, companyIds, readOnlyCompanyIds],
        )
  return rows[0]!.n
}

async function levelsOf(apiKeyId: string): Promise<Record<string, string>> {
  const { rows } = await getPool().query<{ company_id: string; access: string }>(
    `SELECT company_id, access FROM public.api_key_companies WHERE api_key_id = $1`,
    [apiKeyId],
  )
  return Object.fromEntries(rows.map((row) => [row.company_id, row.access]))
}

async function keysWithHash(keyHash: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.api_keys WHERE key_hash = $1`,
    [keyHash],
  )
  return Number(rows[0]!.n)
}

async function validate(keyHash: string): Promise<
  Array<{ company_id: string | null; allowed_company_ids: string[] | null; read_only_company_ids: string[] | null }>
> {
  const { rows } = await getPool().query(
    `SELECT company_id, allowed_company_ids, read_only_company_ids
     FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

/** A user who is a member of three live companies. */
async function seedThreeCompanies(): Promise<{ userId: string; a: string; b: string; c: string }> {
  const { userId, companyId: a } = await seedCompany()
  const b = await insertCompany({ createdBy: userId, name: 'Beta AB' })
  await insertCompanyMember({ companyId: b, userId, role: 'admin' })
  const c = await insertCompany({ createdBy: userId, name: 'Gamma AB' })
  await insertCompanyMember({ companyId: c, userId, role: 'member' })
  return { userId, a, b, c }
}

describe('api_key_companies.access (migration 20260928112724)', () => {
  it('defaults to write and accepts only read or write', async () => {
    const { userId, a, b } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a] })

    await getPool().query(
      `INSERT INTO public.api_key_companies (api_key_id, company_id) VALUES ($1, $2)`,
      [keyId, b],
    )
    expect((await levelsOf(keyId))[b]).toBe('write')

    await expect(
      getPool().query(`UPDATE public.api_key_companies SET access = 'admin' WHERE api_key_id = $1`, [keyId]),
    ).rejects.toThrow(/api_key_companies_access_check/)
    await expect(
      getPool().query(`UPDATE public.api_key_companies SET access = NULL WHERE api_key_id = $1`, [keyId]),
    ).rejects.toThrow(/null value/)
  })
})

describe('validate_and_increment_api_key: read_only_company_ids', () => {
  it('is NULL for an unrestricted key and for a key with no read-only company', async () => {
    const { userId, a, b } = await seedThreeCompanies()
    const unrestrictedHash = freshHash()
    await createKey({ userId, companyId: a, keyHash: unrestrictedHash, companyIds: null })
    const restrictedHash = freshHash()
    await createKey({ userId, companyId: a, keyHash: restrictedHash, companyIds: [a, b], readOnlyCompanyIds: [] })

    expect(await validate(unrestrictedHash)).toEqual([
      { company_id: a, allowed_company_ids: null, read_only_company_ids: null },
    ])
    const [restricted] = await validate(restrictedHash)
    expect(restricted!.company_id).toBe(a)
    expect([...restricted!.allowed_company_ids!].sort()).toEqual([a, b].sort())
    expect(restricted!.read_only_company_ids).toBeNull()
  })

  it('lists the read-only companies in allowlist order, and a read-only company can be the default', async () => {
    const { userId, a, b, c } = await seedThreeCompanies()
    const keyHash = freshHash()
    await createKey({ userId, companyId: a, keyHash, companyIds: [a, b, c], readOnlyCompanyIds: [c, a] })

    const rows = await validate(keyHash)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row!.company_id).toBe(a)
    // Rows written in one call share created_at, so the allowlist order falls
    // back to company_id; the read-only list follows that same order.
    const allowed = row!.allowed_company_ids!
    expect([...allowed].sort()).toEqual([a, b, c].sort())
    expect(row!.read_only_company_ids).toEqual(allowed.filter((id) => id === a || id === c))
  })
})

describe('create_api_key_with_allowlist: read-only companies', () => {
  it('writes each allowed company with its level in the same call', async () => {
    const { userId, a, b, c } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b, c], readOnlyCompanyIds: [b, b, null as unknown as string] })

    expect(await levelsOf(keyId)).toEqual({ [a]: 'write', [b]: 'read', [c]: 'write' })
  })

  it('keeps the thirteen-parameter call working: every allowed company at write', async () => {
    const { userId, a, b } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b] })

    expect(await levelsOf(keyId)).toEqual({ [a]: 'write', [b]: 'write' })
  })

  it('writes NOTHING when read-only companies come with an unrestricted key', async () => {
    const { userId, a } = await seedThreeCompanies()
    const keyHash = freshHash()

    await expect(
      createKey({ userId, companyId: a, keyHash, companyIds: null, readOnlyCompanyIds: [a] }),
    ).rejects.toThrow(/read-only companies require a company allowlist/)
    expect(await keysWithHash(keyHash)).toBe(0)
  })

  it('writes NOTHING when a read-only company is outside the allowlist', async () => {
    const { userId, a, b, c } = await seedThreeCompanies()
    const keyHash = freshHash()

    await expect(
      createKey({ userId, companyId: a, keyHash, companyIds: [a, b], readOnlyCompanyIds: [c] }),
    ).rejects.toThrow(/are not in the allowlist/)
    expect(await keysWithHash(keyHash)).toBe(0)
  })
})

describe('replace_api_key_allowlist: levels', () => {
  it('NULL keeps existing levels and gives newly added companies write', async () => {
    const { userId, a, b, c } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b], readOnlyCompanyIds: [b] })

    expect(await replaceAllowlist(keyId, [a, b, c])).toBe(3)
    expect(await levelsOf(keyId)).toEqual({ [a]: 'write', [b]: 'read', [c]: 'write' })
  })

  it('an array sets the levels exactly, and an empty one lifts every read-only level', async () => {
    const { userId, a, b, c } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b], readOnlyCompanyIds: [b] })

    expect(await replaceAllowlist(keyId, [a, b, c], [a, c])).toBe(3)
    expect(await levelsOf(keyId)).toEqual({ [a]: 'read', [b]: 'write', [c]: 'read' })

    expect(await replaceAllowlist(keyId, [a, b, c], [])).toBe(3)
    expect(await levelsOf(keyId)).toEqual({ [a]: 'write', [b]: 'write', [c]: 'write' })
  })

  it('refuses to make a key with read-only companies unrestricted unless told explicitly', async () => {
    const { userId, a, b } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b], readOnlyCompanyIds: [b] })

    await expect(replaceAllowlist(keyId, null)).rejects.toThrow(/has read-only companies/)
    await expect(replaceAllowlist(keyId, [])).rejects.toThrow(/has read-only companies/)
    expect(await levelsOf(keyId)).toEqual({ [a]: 'write', [b]: 'read' })

    expect(await replaceAllowlist(keyId, null, [])).toBe(0)
    expect(await levelsOf(keyId)).toEqual({})
  })

  it('still clears a key without read-only companies on a plain NULL', async () => {
    const { userId, a, b } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b] })

    expect(await replaceAllowlist(keyId, null)).toBe(0)
    expect(await levelsOf(keyId)).toEqual({})
  })

  it('leaves the old rows untouched when read-only ids are invalid', async () => {
    const { userId, a, b, c } = await seedThreeCompanies()
    const keyId = await createKey({ userId, companyId: a, companyIds: [a, b], readOnlyCompanyIds: [b] })

    await expect(replaceAllowlist(keyId, [a, b], [c])).rejects.toThrow(/are not in the allowlist/)
    await expect(replaceAllowlist(keyId, null, [a])).rejects.toThrow(/require a company allowlist/)
    expect(await levelsOf(keyId)).toEqual({ [a]: 'write', [b]: 'read' })
  })
})

describe('api key access-level RPCs: privileges', () => {
  it('keep the new signatures EXECUTE-denied to anon and authenticated', async () => {
    const { rows } = await getPool().query<{ role: string; validate: boolean; create: boolean; replace: boolean }>(
      `SELECT r.role,
              has_function_privilege(r.role, 'public.validate_and_increment_api_key(text)', 'EXECUTE') AS validate,
              has_function_privilege(r.role, 'public.create_api_key_with_allowlist(uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[], uuid[])', 'EXECUTE') AS create,
              has_function_privilege(r.role, 'public.replace_api_key_allowlist(uuid, uuid[], uuid[])', 'EXECUTE') AS replace
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)
       ORDER BY r.role`,
    )
    expect(rows).toEqual([
      { role: 'anon', validate: false, create: false, replace: false },
      { role: 'authenticated', validate: false, create: false, replace: false },
      { role: 'service_role', validate: true, create: true, replace: true },
    ])
  })

  it('leaves no overload of the old signatures behind', async () => {
    const { rows } = await getPool().query<{ proname: string; n: string }>(
      `SELECT proname, count(*)::text AS n
       FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('create_api_key_with_allowlist', 'replace_api_key_allowlist', 'validate_and_increment_api_key')
       GROUP BY proname
       ORDER BY proname`,
    )
    expect(rows).toEqual([
      { proname: 'create_api_key_with_allowlist', n: '1' },
      { proname: 'replace_api_key_allowlist', n: '1' },
      { proname: 'validate_and_increment_api_key', n: '1' },
    ])
  })
})
