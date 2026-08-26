import { describe, expect, it } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * Unbound API keys (migration 20260826090000): a key minted from the OAuth
 * popup before the user's first company exists carries company_id NULL.
 * The NOT NULL from 20260330130000's dynamic loop made the token endpoint's
 * insert fail with a plain 500 on every fresh Claude.ai authorization; a
 * mocked client cannot see a column constraint, so this pins it on real
 * Postgres.
 */
describe('api_keys unbound insert.pg', () => {
  it('accepts a key with no company binding', async () => {
    const userId = await insertAuthUser()
    const keyHash = createHash('sha256').update(randomUUID()).digest('hex')
    const inserted = await getPool().query<{ id: string; company_id: string | null }>(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, NULL, $2, 'gnubok_sk_test', 'MCP-klient (OAuth)', ARRAY['companies:read'])
       RETURNING id, company_id`,
      [userId, keyHash],
    )
    expect(inserted.rows[0]!.company_id).toBeNull()

    // The lazy bind heals exactly the unbound row.
    const companyRes = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_user($1::uuid, 'Bind AB', 'aktiebolag', NULL) AS id`,
      [userId],
    )
    await getPool().query(
      `UPDATE public.api_keys SET company_id = $1 WHERE id = $2 AND company_id IS NULL`,
      [companyRes.rows[0]!.id, inserted.rows[0]!.id],
    )
    const healed = await getPool().query<{ company_id: string | null }>(
      `SELECT company_id FROM public.api_keys WHERE id = $1`,
      [inserted.rows[0]!.id],
    )
    expect(healed.rows[0]!.company_id).toBe(companyRes.rows[0]!.id)
  })
})
