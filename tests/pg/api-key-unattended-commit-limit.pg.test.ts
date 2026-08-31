import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from './fixtures'
import { getPool } from './setup'

/**
 * api_keys.unattended_commit_limit (migration 20260831111519).
 *
 * The column is the storage half of the approval-authority envelope; the
 * enforcement half is TypeScript (lib/pending-operations/unattended-limit.ts),
 * deliberately, because a RAISE inside commit_journal_entry is swallowed into
 * a retryable 500 and burns the staged operation.
 *
 * What must hold in the database, and is what these tests pin:
 *   1. the column exists, is nullable, and defaults to NULL (unlimited), so
 *      every key that existed before this migration keeps its behaviour;
 *   2. the CHECK rejects 0 and negatives, so "limit = 0" can never be stored
 *      and silently read back as falsy-therefore-unlimited;
 *   3. validate_and_increment_api_key returns it, with exactly ONE signature
 *      (adding a parameter or return column to a Postgres function creates an
 *      overload rather than replacing it, and PostgREST then 300s on the
 *      ambiguity: see migration 20260421140000);
 *   4. writing it produces an audit_log row, since changing how much an agent
 *      may post without a human is a change to who approves the company's
 *      bookkeeping (BFL 5 kap. 11 paragraf).
 */
describe('api_keys.unattended_commit_limit (pg)', () => {
  async function seedKey(limit: number | null = null) {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const apiKeyId = randomUUID()
    const keyHash = randomUUID().replaceAll('-', '')
    await getPool().query(
      `INSERT INTO public.api_keys
         (id, user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit)
       VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Envelope test key', $5, $6)`,
      [apiKeyId, userId, companyId, keyHash, ['reports:read'], limit],
    )
    return { userId, companyId, apiKeyId, keyHash }
  }

  it('defaults to NULL so pre-existing keys stay unlimited', async () => {
    const { apiKeyId } = await seedKey()
    const { rows } = await getPool().query<{ unattended_commit_limit: string | null }>(
      `SELECT unattended_commit_limit FROM public.api_keys WHERE id = $1`,
      [apiKeyId],
    )
    expect(rows[0]!.unattended_commit_limit).toBeNull()
  })

  it('rejects a zero or negative ceiling with the CHECK constraint', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    for (const bad of [0, -1]) {
      await expect(
        getPool().query(
          `INSERT INTO public.api_keys
             (user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit)
           VALUES ($1, $2, $3, 'gnubok_sk_test', 'Bad ceiling', $4, $5)`,
          [userId, companyId, randomUUID().replaceAll('-', ''), ['reports:read'], bad],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'api_keys_unattended_commit_limit_positive',
      })
    }
  })

  it('validate_and_increment_api_key returns the ceiling, and has exactly one signature', async () => {
    const { keyHash } = await seedKey(2500)

    const overloads = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'validate_and_increment_api_key'`,
    )
    expect(overloads.rows[0]!.n).toBe(1)

    const { rows } = await getPool().query<{
      unattended_commit_limit: string | null
      rate_limited: boolean
    }>(`SELECT * FROM public.validate_and_increment_api_key($1)`, [keyHash])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.rate_limited).toBe(false)
    // numeric comes back as a string from node-postgres; compare numerically.
    expect(Number(rows[0]!.unattended_commit_limit)).toBe(2500)
  })

  it('returns NULL for a key with no ceiling, not 0', async () => {
    const { keyHash } = await seedKey(null)
    const { rows } = await getPool().query<{ unattended_commit_limit: string | null }>(
      `SELECT * FROM public.validate_and_increment_api_key($1)`,
      [keyHash],
    )
    // The whole guard is written NULL-first. A 0 here would read as a real
    // ceiling on the way in and block every commit the key attempts.
    expect(rows[0]!.unattended_commit_limit).toBeNull()
  })

  it('records a ceiling change in audit_log', async () => {
    const { apiKeyId } = await seedKey(null)

    await getPool().query(
      `UPDATE public.api_keys SET unattended_commit_limit = 10000 WHERE id = $1`,
      [apiKeyId],
    )

    const { rows } = await getPool().query<{
      action: string
      old_limit: string | null
      new_limit: string | null
    }>(
      `SELECT action,
              old_state ->> 'unattended_commit_limit' AS old_limit,
              new_state ->> 'unattended_commit_limit' AS new_limit
       FROM public.audit_log
       WHERE table_name = 'api_keys' AND record_id = $1 AND action = 'UPDATE'
       ORDER BY created_at, id`,
      [apiKeyId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.old_limit).toBeNull()
    expect(Number(rows[0]!.new_limit)).toBe(10000)
  })
})
