import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for validate_and_increment_api_key when the key's stored
 * company is gone: archived (a migration reset archives the source company
 * and hands the user a replacement) or a membership the user no longer has.
 *
 * Locks in:
 *   - An OAuth connection (a key with a refresh token) without a company
 *     allowlist is unbound instead of refused: company_id comes back NULL and
 *     is cleared on the row, so validateApiKey's lazy bind attaches it to the
 *     user's active company, exactly what reconnecting would mint. It never
 *     answers with the company that is gone.
 *   - A manual key keeps failing closed: no row, as before.
 *   - A restricted key whose stored company is on its allowlist but archived
 *     answers with its first live allowed company, the same rule as a stored
 *     company outside the allowlist; nothing live left still refuses.
 */

async function insertApiKey(params: {
  userId: string
  companyId: string | null
  oauth: boolean
}): Promise<{ id: string; keyHash: string }> {
  const id = randomUUID()
  // key_hash and refresh_token_hash are unique: fresh random values per key.
  const keyHash = randomUUID().replace(/-/g, '').padEnd(64, '0')
  const refreshTokenHash = params.oauth ? randomUUID().replace(/-/g, '').padEnd(64, '1') : null
  await getPool().query(
    `INSERT INTO public.api_keys
       (id, user_id, company_id, key_hash, key_prefix, name, scopes, refresh_token_hash)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'pg-real stale company key', $5, $6)`,
    [id, params.userId, params.companyId, keyHash, ['companies:read'], refreshTokenHash],
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

async function archive(companyId: string): Promise<void> {
  await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [companyId])
}

async function addCompany(userId: string): Promise<string> {
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return companyId
}

interface ValidateRow {
  company_id: string | null
  allowed_company_ids: string[] | null
}

async function validate(keyHash: string): Promise<ValidateRow[]> {
  const { rows } = await getPool().query<ValidateRow>(
    `SELECT company_id, allowed_company_ids
     FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

async function storedCompanyId(apiKeyId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ company_id: string | null }>(
    `SELECT company_id FROM public.api_keys WHERE id = $1`,
    [apiKeyId],
  )
  return rows[0]!.company_id
}

describe('validate_and_increment_api_key: OAuth connection whose company is gone', () => {
  it('unbinds the key when its company is archived and the user has another company', async () => {
    const { userId, companyId: archived } = await seedCompany()
    await addCompany(userId)
    const key = await insertApiKey({ userId, companyId: archived, oauth: true })

    expect((await validate(key.keyHash))[0]?.company_id).toBe(archived)

    await archive(archived)

    expect(await validate(key.keyHash)).toEqual([{ company_id: null, allowed_company_ids: null }])
    expect(await storedCompanyId(key.id)).toBeNull()
  })

  it('unbinds the key when the user left its company', async () => {
    const { userId, companyId: left } = await seedCompany()
    await addCompany(userId)
    const key = await insertApiKey({ userId, companyId: left, oauth: true })

    await getPool().query(
      `DELETE FROM public.company_members WHERE user_id = $1 AND company_id = $2`,
      [userId, left],
    )

    expect(await validate(key.keyHash)).toEqual([{ company_id: null, allowed_company_ids: null }])
    expect(await storedCompanyId(key.id)).toBeNull()
  })

  it('unbinds the key when the archived company was the only one, and never answers with it', async () => {
    const { userId, companyId } = await seedCompany()
    const key = await insertApiKey({ userId, companyId, oauth: true })

    await archive(companyId)

    expect(await validate(key.keyHash)).toEqual([{ company_id: null, allowed_company_ids: null }])
    // A second call reads the unbound row: still no company, no refusal.
    expect(await validate(key.keyHash)).toEqual([{ company_id: null, allowed_company_ids: null }])
  })

  it('records the unbinding in the audit log', async () => {
    const { userId, companyId: archived } = await seedCompany()
    const key = await insertApiKey({ userId, companyId: archived, oauth: true })

    await archive(archived)
    await validate(key.keyHash)

    const { rows } = await getPool().query<{ old_company: string | null; new_company: string | null }>(
      `SELECT old_state ->> 'company_id' AS old_company, new_state ->> 'company_id' AS new_company
       FROM public.audit_log
       WHERE table_name = 'api_keys' AND record_id = $1 AND action = 'UPDATE'`,
      [key.id],
    )
    expect(rows).toEqual([{ old_company: archived, new_company: null }])
  })
})

describe('validate_and_increment_api_key: keys that keep failing closed', () => {
  it('still refuses a manual key whose company is archived', async () => {
    const { userId, companyId: archived } = await seedCompany()
    await addCompany(userId)
    const key = await insertApiKey({ userId, companyId: archived, oauth: false })

    await archive(archived)

    expect(await validate(key.keyHash)).toEqual([])
    expect(await storedCompanyId(key.id)).toBe(archived)
  })
})

describe('validate_and_increment_api_key: restricted key whose stored company is archived', () => {
  it('answers with the first live allowed company', async () => {
    const { userId, companyId: archived } = await seedCompany()
    const stillLive = await addCompany(userId)
    const key = await insertApiKey({ userId, companyId: archived, oauth: true })
    await allow(key.id, archived, '2026-01-01T00:00:00Z')
    await allow(key.id, stillLive, '2026-02-01T00:00:00Z')

    await archive(archived)

    const rows = await validate(key.keyHash)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.company_id).toBe(stillLive)
    expect(rows[0]!.allowed_company_ids).toEqual([archived, stillLive])
  })

  it('refuses when no allowed company is live', async () => {
    const { userId, companyId: archived } = await seedCompany()
    await addCompany(userId)
    const key = await insertApiKey({ userId, companyId: archived, oauth: true })
    await allow(key.id, archived, '2026-01-01T00:00:00Z')

    await archive(archived)

    expect(await validate(key.keyHash)).toEqual([])
    expect(await storedCompanyId(key.id)).toBe(archived)
  })
})
