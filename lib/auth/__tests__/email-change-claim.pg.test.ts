import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// claim_email_change_request / release_email_change_request
// (20260903083000_email_change_request_claims.sql): the cross-instance gate
// in front of GoTrue's updateUser in POST /api/account/email. Exactly one
// caller per user, address and window may proceed; the rest must answer
// "already pending" without re-issuing confirmation tokens.
//
// withUserContext rolls its transaction back, which would hide the claim
// from the next call. These helpers commit instead, because the claim's
// whole point is what a SECOND transaction sees; the test users are fresh
// per test and their rows cascade away with them.

const WINDOW = 30 * 60

async function asUser<T>(
  userId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE authenticated`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function claim(userId: string, email: string, window = WINDOW): Promise<boolean> {
  return asUser(userId, async (client) => {
    const { rows } = await client.query<{ claim_email_change_request: boolean }>(
      `SELECT public.claim_email_change_request($1, $2)`,
      [email, window],
    )
    return rows[0]!.claim_email_change_request
  })
}

async function release(userId: string): Promise<void> {
  await asUser(userId, async (client) => {
    await client.query(`SELECT public.release_email_change_request()`)
  })
}

async function backdateClaim(userId: string, seconds: number): Promise<void> {
  await getPool().query(
    `UPDATE public.email_change_requests
        SET claimed_at = now() - make_interval(secs => $2)
      WHERE user_id = $1`,
    [userId, seconds],
  )
}

describe('claim_email_change_request', () => {
  it('grants the first claim and refuses a repeat for the same address inside the window', async () => {
    const userId = await insertAuthUser()

    expect(await claim(userId, 'new@testbrand.example')).toBe(true)
    expect(await claim(userId, 'new@testbrand.example')).toBe(false)
    // Case and whitespace are not a different address.
    expect(await claim(userId, '  New@Testbrand.example ')).toBe(false)
  })

  it('grants a claim for a different address while one is held', async () => {
    const userId = await insertAuthUser()

    expect(await claim(userId, 'first@testbrand.example')).toBe(true)
    expect(await claim(userId, 'second@testbrand.example')).toBe(true)
    // ... and the first address is now the "different" one again.
    expect(await claim(userId, 'first@testbrand.example')).toBe(true)
  })

  it('grants a repeat once the held claim is older than the window', async () => {
    const userId = await insertAuthUser()

    expect(await claim(userId, 'new@testbrand.example')).toBe(true)
    await backdateClaim(userId, WINDOW + 5)
    expect(await claim(userId, 'new@testbrand.example')).toBe(true)
    expect(await claim(userId, 'new@testbrand.example')).toBe(false)
  })

  it('lets exactly one of three concurrent claimers through', async () => {
    const userId = await insertAuthUser()

    const results = await Promise.all([
      claim(userId, 'new@testbrand.example'),
      claim(userId, 'new@testbrand.example'),
      claim(userId, 'new@testbrand.example'),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('keeps claims per user', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()

    expect(await claim(a, 'shared@testbrand.example')).toBe(true)
    expect(await claim(b, 'shared@testbrand.example')).toBe(true)
  })

  it('release drops the claim so the same address can be requested again', async () => {
    const userId = await insertAuthUser()

    expect(await claim(userId, 'new@testbrand.example')).toBe(true)
    await release(userId)
    expect(await claim(userId, 'new@testbrand.example')).toBe(true)
  })

  it('release only touches the caller', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()

    expect(await claim(a, 'a@testbrand.example')).toBe(true)
    expect(await claim(b, 'b@testbrand.example')).toBe(true)
    await release(a)
    expect(await claim(b, 'b@testbrand.example')).toBe(false)
  })

  it('rejects an empty address and a non-positive window', async () => {
    const userId = await insertAuthUser()

    await expect(claim(userId, '   ')).rejects.toThrow(/requires an address/)
    await expect(claim(userId, 'new@testbrand.example', 0)).rejects.toThrow(
      /positive window/,
    )
  })

  it('refuses unauthenticated callers', async () => {
    await expect(
      getPool().query(`SELECT public.claim_email_change_request('x@testbrand.example', 60)`),
    ).rejects.toThrow(/authenticated user/)
    await expect(
      getPool().query(`SELECT public.release_email_change_request()`),
    ).rejects.toThrow(/authenticated user/)
  })

  it('is not readable or writable directly by an authenticated user', async () => {
    const userId = await insertAuthUser()
    expect(await claim(userId, 'new@testbrand.example')).toBe(true)

    const visible = await asUser(userId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM public.email_change_requests`)
      return rows.length
    })
    expect(visible).toBe(0)

    await expect(
      asUser(userId, async (client) => {
        await client.query(`DELETE FROM public.email_change_requests`)
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM public.email_change_requests`,
        )
        return rows[0]
      }),
    ).resolves.toBeDefined()
    // RLS with no policies: the DELETE above matched nothing.
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.email_change_requests WHERE user_id = $1`,
      [userId],
    )
    expect(rows[0]!.n).toBe(1)
  })
})
