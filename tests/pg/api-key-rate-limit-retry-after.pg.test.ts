import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getPool } from './setup'

/**
 * validate_and_increment_api_key: the per-minute limit and the wait
 * (migration 20261119081500, issue #225).
 *
 * What must hold:
 *   1. every answered row carries the key's rate_limit_per_minute;
 *   2. a limited row carries retry_after_seconds, the whole seconds left in
 *      the key's fixed one-minute window, rounded up and held to 1..60;
 *      a row that is not limited carries NULL;
 *   3. the limited branch still counts nothing and does not slide the window;
 *   4. the function keeps exactly one signature (a changed RETURNS TABLE
 *      must replace it, not add an overload PostgREST cannot pick between).
 */
describe('validate_and_increment_api_key rate-limit answer (pg)', () => {
  interface Row {
    rate_limited: boolean
    rate_limit_per_minute: number | null
    retry_after_seconds: number | null
  }

  async function seedKey(rpm: number) {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const apiKeyId = randomUUID()
    const keyHash = randomUUID().replaceAll('-', '')
    await getPool().query(
      `INSERT INTO public.api_keys
         (id, user_id, company_id, key_hash, key_prefix, name, scopes, rate_limit_rpm)
       VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Rate limit key', $5, $6)`,
      [apiKeyId, userId, companyId, keyHash, ['reports:read'], rpm],
    )
    return { apiKeyId, keyHash }
  }

  async function validate(keyHash: string): Promise<Row> {
    const { rows } = await getPool().query<Row>(
      `SELECT rate_limited, rate_limit_per_minute, retry_after_seconds
       FROM public.validate_and_increment_api_key($1)`,
      [keyHash],
    )
    expect(rows).toHaveLength(1)
    return rows[0]!
  }

  async function setWindowStart(apiKeyId: string, offset: string) {
    await getPool().query(
      `UPDATE public.api_keys SET rate_limit_window_start = now() + $2::interval WHERE id = $1`,
      [apiKeyId, offset],
    )
  }

  it('has exactly one signature', async () => {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'validate_and_increment_api_key'`,
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('answers the limit on every row and no wait while under it', async () => {
    const { keyHash } = await seedKey(2)
    // First call opens the window, second counts inside it.
    for (let i = 0; i < 2; i++) {
      expect(await validate(keyHash)).toEqual({
        rate_limited: false,
        rate_limit_per_minute: 2,
        retry_after_seconds: null,
      })
    }
  })

  it('answers the seconds left in the window once limited, without counting or sliding it', async () => {
    const { apiKeyId, keyHash } = await seedKey(2)
    await validate(keyHash)
    await validate(keyHash)
    // The window opened 45 seconds ago: about 15 seconds are left.
    await setWindowStart(apiKeyId, '-45 seconds')
    const before = await getPool().query<{ request_count: number; rate_limit_window_start: Date }>(
      `SELECT request_count, rate_limit_window_start FROM public.api_keys WHERE id = $1`,
      [apiKeyId],
    )

    const limited = await validate(keyHash)
    expect(limited.rate_limited).toBe(true)
    expect(limited.rate_limit_per_minute).toBe(2)
    expect(limited.retry_after_seconds).toBeGreaterThanOrEqual(14)
    expect(limited.retry_after_seconds).toBeLessThanOrEqual(15)

    const after = await getPool().query<{ request_count: number; rate_limit_window_start: Date }>(
      `SELECT request_count, rate_limit_window_start FROM public.api_keys WHERE id = $1`,
      [apiKeyId],
    )
    expect(after.rows[0]!.request_count).toBe(before.rows[0]!.request_count)
    expect(after.rows[0]!.rate_limit_window_start.getTime()).toBe(
      before.rows[0]!.rate_limit_window_start.getTime(),
    )
  })

  it('holds the wait to 60 seconds when the window start lies ahead of the clock', async () => {
    const { apiKeyId, keyHash } = await seedKey(1)
    await validate(keyHash)
    await setWindowStart(apiKeyId, '5 minutes')
    const limited = await validate(keyHash)
    expect(limited.rate_limited).toBe(true)
    expect(limited.retry_after_seconds).toBe(60)
  })

  it('opens a new window, with no wait, once the old one has run out', async () => {
    const { apiKeyId, keyHash } = await seedKey(1)
    await validate(keyHash)
    expect((await validate(keyHash)).rate_limited).toBe(true)
    await setWindowStart(apiKeyId, '-2 minutes')
    expect(await validate(keyHash)).toEqual({
      rate_limited: false,
      rate_limit_per_minute: 1,
      retry_after_seconds: null,
    })
  })
})
