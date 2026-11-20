/**
 * claim_idempotency_key (migration 20261016004000): a keyed write claims its
 * key before it runs, so two requests with one key can no longer both run.
 *
 * What this proves against real Postgres, where the advisory lock and the
 * READ COMMITTED snapshots are the real ones:
 *   - two concurrent claims for the same key: exactly one wins, the other
 *     waits on the lock and then sees the winner's claim (in_progress);
 *   - a claim past its TTL (its request was killed) is taken over in the same
 *     call, with no cron;
 *   - a completed key replays its stored response;
 *   - the same key with another body is still `reuse`
 *     (409 IDEMPOTENCY_KEY_REUSE), in progress or completed;
 *   - company_create claims carry no company until they complete, and never
 *     match a company-scoped key or another user;
 *   - only the service role may call it, and the table's shape constraints
 *     hold the claim states.
 */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

const TTL_SECONDS = 900

type Queryable = Pool | PoolClient

interface ClaimArgs {
  userId: string
  companyId: string | null
  scope?: string
  key: string
  hash: string
  ttl?: number
}

interface ClaimOutcome {
  outcome: 'claimed' | 'replay' | 'reuse' | 'in_progress'
  claim_id?: string
  response_status?: string
  response_body?: Record<string, unknown>
}

async function claim(db: Queryable, args: ClaimArgs): Promise<ClaimOutcome> {
  const result = await db.query<{ r: ClaimOutcome }>(
    'SELECT public.claim_idempotency_key($1, $2, $3, $4, $5, $6) AS r',
    [
      args.userId,
      args.companyId,
      args.scope ?? (args.companyId === null ? 'company_create' : 'api_route'),
      args.key,
      args.hash,
      args.ttl ?? TTL_SECONDS,
    ],
  )
  return result.rows[0]!.r
}

/** What the app's claim.complete() writes (src/lib/api/idempotency.ts). */
async function complete(claimId: string, body: Record<string, unknown>, companyId?: string): Promise<number> {
  const result = await getPool().query(
    `UPDATE public.idempotency_keys
        SET state = 'completed', response_status = 'success', response_body = $2,
            expires_at = now() + interval '24 hours', company_id = coalesce($3, company_id)
      WHERE id = $1 AND state = 'in_progress'`,
    [claimId, JSON.stringify(body), companyId ?? null],
  )
  return result.rowCount ?? 0
}

/** Simulate a claim whose request was killed: age it past its TTL. */
async function abandon(claimId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.idempotency_keys SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [claimId],
  )
}

async function rowsFor(userId: string, key: string) {
  const result = await getPool().query<{ id: string; company_id: string | null; state: string; request_hash: string }>(
    `SELECT id, company_id, state, request_hash FROM public.idempotency_keys WHERE user_id = $1 AND key = $2`,
    [userId, key],
  )
  return result.rows
}

/** Resolves to the promise's value, or 'pending' if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))])
}

describe('claim_idempotency_key: concurrent claims', () => {
  it('lets exactly one of two concurrent claims win: the second waits on the lock, then sees the claim', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    const first = await getClient()
    const second = await getClient()
    try {
      await first.query('BEGIN')
      const won = await claim(first, { userId, companyId, key, hash: 'h' })
      expect(won.outcome).toBe('claimed')

      // The first transaction still holds the key's lock: the second claim
      // blocks instead of deciding on a snapshot that cannot see the claim.
      const waiting = claim(second, { userId, companyId, key, hash: 'h' })
      expect(await within(waiting, 300)).toBe('pending')

      await first.query('COMMIT')
      expect((await waiting).outcome).toBe('in_progress')
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }
    expect(await rowsFor(userId, key)).toHaveLength(1)
  })

  it('admits one claim out of a burst of eight on separate connections', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => claim(getPool(), { userId, companyId, key, hash: 'h' })),
    )
    expect(outcomes.filter((o) => o.outcome === 'claimed')).toHaveLength(1)
    expect(outcomes.filter((o) => o.outcome === 'in_progress')).toHaveLength(7)
    expect(await rowsFor(userId, key)).toHaveLength(1)
  })

  it('admits one company_create claim out of a burst: the claim before any company exists', async () => {
    const userId = await insertAuthUser()
    const key = randomUUID()
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => claim(getPool(), { userId, companyId: null, key, hash: 'h' })),
    )
    expect(outcomes.filter((o) => o.outcome === 'claimed')).toHaveLength(1)
    expect(outcomes.filter((o) => o.outcome === 'in_progress')).toHaveLength(7)
    const rows = await rowsFor(userId, key)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ company_id: null, state: 'in_progress' })
  })
})

describe('claim_idempotency_key: abandoned claims', () => {
  it('takes over a claim past its TTL in the same call, and leaves one row', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    const abandoned = await claim(getPool(), { userId, companyId, key, hash: 'h' })
    await abandon(abandoned.claim_id!)

    const taken = await claim(getPool(), { userId, companyId, key, hash: 'h' })
    expect(taken.outcome).toBe('claimed')
    expect(taken.claim_id).not.toBe(abandoned.claim_id)
    const rows = await rowsFor(userId, key)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(taken.claim_id)

    // The overtaken request finishing late stores nothing over the new claim.
    expect(await complete(abandoned.claim_id!, { late: true })).toBe(0)
  })

  it('takes over an abandoned claim whatever body it carried: a dead claim holds the key for nobody', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    const abandoned = await claim(getPool(), { userId, companyId, key, hash: 'first body' })
    await abandon(abandoned.claim_id!)
    expect((await claim(getPool(), { userId, companyId, key, hash: 'second body' })).outcome).toBe('claimed')
  })

  it('does not take over a claim younger than its TTL', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    await claim(getPool(), { userId, companyId, key, hash: 'h' })
    expect((await claim(getPool(), { userId, companyId, key, hash: 'h' })).outcome).toBe('in_progress')
  })

  it('takes over an abandoned company_create claim', async () => {
    const userId = await insertAuthUser()
    const key = randomUUID()
    const abandoned = await claim(getPool(), { userId, companyId: null, key, hash: 'h' })
    await abandon(abandoned.claim_id!)
    const taken = await claim(getPool(), { userId, companyId: null, key, hash: 'h' })
    expect(taken.outcome).toBe('claimed')
    expect(await rowsFor(userId, key)).toHaveLength(1)
  })

  it('lets a response past its 24 h give way to a new claim', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    const first = await claim(getPool(), { userId, companyId, key, hash: 'h' })
    await complete(first.claim_id!, { data: { id: 'inv-1' } })
    await abandon(first.claim_id!)
    expect((await claim(getPool(), { userId, companyId, key, hash: 'other' })).outcome).toBe('claimed')
  })
})

describe('claim_idempotency_key: replay and key reuse', () => {
  it('replays a completed key', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()
    const first = await claim(getPool(), { userId, companyId, key, hash: 'h' })
    expect(await complete(first.claim_id!, { data: { id: 'inv-1' } })).toBe(1)

    expect(await claim(getPool(), { userId, companyId, key, hash: 'h' })).toEqual({
      outcome: 'replay',
      response_status: 'success',
      response_body: { data: { id: 'inv-1' } },
    })
  })

  it('answers reuse for the same key with another body, completed or still in progress', async () => {
    const { userId, companyId } = await seedCompany()
    const inFlight = randomUUID()
    await claim(getPool(), { userId, companyId, key: inFlight, hash: 'body-a' })
    expect((await claim(getPool(), { userId, companyId, key: inFlight, hash: 'body-b' })).outcome).toBe('reuse')

    const done = randomUUID()
    const first = await claim(getPool(), { userId, companyId, key: done, hash: 'body-a' })
    await complete(first.claim_id!, {})
    expect((await claim(getPool(), { userId, companyId, key: done, hash: 'body-b' })).outcome).toBe('reuse')
  })

  it('keeps keys per company: the same key in another company is another write', async () => {
    const { userId, companyId } = await seedCompany()
    const other = await seedCompany()
    await insertCompanyMember({ companyId: other.companyId, userId, role: 'owner' })
    const key = randomUUID()
    expect((await claim(getPool(), { userId, companyId, key, hash: 'h' })).outcome).toBe('claimed')
    expect((await claim(getPool(), { userId, companyId: other.companyId, key, hash: 'h' })).outcome).toBe('claimed')
  })

  it('replays a company create under the company it created, and never matches a company-scoped key or another user', async () => {
    const { userId, companyId } = await seedCompany()
    const key = randomUUID()

    // A key spent on a company-scoped write never answers a company create.
    const scoped = await claim(getPool(), { userId, companyId, key, hash: 'h' })
    await complete(scoped.claim_id!, {})
    const create = await claim(getPool(), { userId, companyId: null, key, hash: 'h' })
    expect(create.outcome).toBe('claimed')

    // Completing names the created company; the replay is per (user, scope, key).
    const created = await seedCompany()
    expect(await complete(create.claim_id!, { data: { id: created.companyId } }, created.companyId)).toBe(1)
    expect(await claim(getPool(), { userId, companyId: null, key, hash: 'h' })).toMatchObject({
      outcome: 'replay',
      response_body: { data: { id: created.companyId } },
    })
    expect((await claim(getPool(), { userId, companyId: null, key, hash: 'other' })).outcome).toBe('reuse')

    const otherUser = await insertAuthUser()
    expect((await claim(getPool(), { userId: otherUser, companyId: null, key, hash: 'h' })).outcome).toBe('claimed')
  })
})

describe('claim_idempotency_key: access and arguments', () => {
  it('is refused to anon and authenticated, and runs for the service role', async () => {
    const { userId, companyId } = await seedCompany()
    for (const role of ['anon', 'authenticated']) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL ROLE ${role}`)
        await expect(claim(client, { userId, companyId, key: randomUUID(), hash: 'h' })).rejects.toThrow(
          /permission denied/i,
        )
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
    const outcome = await runAsServiceRole((client) => claim(client, { userId, companyId, key: randomUUID(), hash: 'h' }))
    expect(outcome.outcome).toBe('claimed')
  })

  it('refuses a claim without a company outside company_create, and a TTL out of range', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      claim(getPool(), { userId, companyId: null, scope: 'api_route', key: randomUUID(), hash: 'h' }),
    ).rejects.toThrow(/needs a company/)
    await expect(claim(getPool(), { userId, companyId, key: randomUUID(), hash: 'h', ttl: 0 })).rejects.toThrow(
      /p_claim_ttl_seconds/,
    )
    await expect(claim(getPool(), { userId, companyId, key: '  ', hash: 'h' })).rejects.toThrow(/required/)
  })
})

describe('idempotency_keys: claim shape', () => {
  it('keeps a completed row complete: a response status and a company', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, state)
         VALUES ($1, $2, $3, 'h', 'completed')`,
        [userId, companyId, randomUUID()],
      ),
    ).rejects.toThrow(/idempotency_keys_response_matches_state/)
    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, response_status)
         VALUES ($1, NULL, $2, 'h', 'success')`,
        [userId, randomUUID()],
      ),
    ).rejects.toThrow(/idempotency_keys_company_id_not_null/)
  })

  it('allows a claim without a company only for company_create, one in flight per user and key', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, scope, state, response_status)
         VALUES ($1, NULL, $2, 'h', 'mcp_tool', 'in_progress', NULL)`,
        [userId, randomUUID()],
      ),
    ).rejects.toThrow(/idempotency_keys_company_id_not_null/)

    const key = randomUUID()
    const insertClaim = () =>
      getPool().query(
        `INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, scope, state, response_status)
         VALUES ($1, NULL, $2, 'h', 'company_create', 'in_progress', NULL)`,
        [userId, key],
      )
    await insertClaim()
    await expect(insertClaim()).rejects.toThrow(/idx_idempotency_keys_company_create_claim|duplicate key/)
  })
})
