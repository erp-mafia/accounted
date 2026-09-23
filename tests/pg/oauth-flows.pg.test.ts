import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Migration 20260907120000_oauth_flows.sql: the one-row-per-flow table behind
 * lib/auth/oauth-flows.ts. Locks in the three things the application relies
 * on and cannot prove with mocks:
 *
 *  - the table is service-role only (RLS enabled, browser roles revoked);
 *  - consuming the state and consuming the handoff are single statements
 *    whose WHERE clause carries the whole check, so two concurrent
 *    deliveries yield exactly one winner;
 *  - the handoff can only be claimed from the origin it was minted for.
 */

async function insertFlow(params: {
  companyId: string
  userId: string
  origin?: string
  expiresInSeconds?: number
}): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await getPool().query(
    `INSERT INTO public.oauth_flows
       (id, kind, company_id, user_id, origin, redirect_uri, expires_at)
     VALUES ($1, 'skatteverket', $2, $3, $4, 'https://oauth.testbrand.example/cb',
             now() + make_interval(secs => $5))`,
    [id, params.companyId, params.userId, params.origin ?? 'https://app.testbrand.example', params.expiresInSeconds ?? 600],
  )
  return id
}

// Mirrors consumeOAuthFlowState's PostgREST statement.
const CONSUME_STATE = `
  UPDATE public.oauth_flows SET used_at = now()
   WHERE id = $1 AND kind = 'skatteverket' AND used_at IS NULL AND expires_at > now()
  RETURNING id`

// Mirrors consumeOAuthFlowHandoff's PostgREST statement.
const CONSUME_HANDOFF = `
  DELETE FROM public.oauth_flows
   WHERE handoff_id = $1 AND origin = $2 AND kind = 'skatteverket'
     AND handoff_expires_at > now()
  RETURNING id, handoff_code`

async function mintHandoff(id: string, expiresInSeconds = 120): Promise<string> {
  const handoffId = randomBytes(32).toString('base64url')
  await getPool().query(
    `UPDATE public.oauth_flows
        SET handoff_id = $2, handoff_code = 'v1:ciphertext',
            handoff_expires_at = now() + make_interval(secs => $3)
      WHERE id = $1`,
    [id, handoffId, expiresInSeconds],
  )
  return handoffId
}

describe('oauth_flows (pg)', () => {
  async function expectDenied(role: 'anon' | 'authenticated', sql: string) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${role}`)
      await expect(client.query(sql)).rejects.toThrow(/permission denied/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  }

  it('denies the browser-facing roles entirely', async () => {
    await expectDenied('anon', 'SELECT * FROM public.oauth_flows LIMIT 1')
    await expectDenied('authenticated', 'SELECT * FROM public.oauth_flows LIMIT 1')
    await expectDenied(
      'authenticated',
      `INSERT INTO public.oauth_flows (id, kind, company_id, user_id, origin, redirect_uri, expires_at)
       VALUES ('x', 'skatteverket', gen_random_uuid(), gen_random_uuid(), 'https://a', 'https://b', now())`,
    )
  })

  it('lets exactly one of two concurrent deliveries consume the state', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertFlow({ companyId, userId })

    const a = await getClient()
    const b = await getClient()
    try {
      const [ra, rb] = await Promise.all([
        a.query(CONSUME_STATE, [id]),
        b.query(CONSUME_STATE, [id]),
      ])
      expect(ra.rowCount! + rb.rowCount!).toBe(1)
    } finally {
      a.release()
      b.release()
    }

    // And nothing after that: the state is spent.
    const again = await getPool().query(CONSUME_STATE, [id])
    expect(again.rowCount).toBe(0)
  })

  it('refuses an expired state', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertFlow({ companyId, userId, expiresInSeconds: -1 })
    const res = await getPool().query(CONSUME_STATE, [id])
    expect(res.rowCount).toBe(0)
  })

  it('claims the handoff once, and only from the recorded origin', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertFlow({ companyId, userId, origin: 'https://brand.testbrand.example' })
    await getPool().query(CONSUME_STATE, [id])
    const handoffId = await mintHandoff(id)

    // Wrong origin: nothing, and the row is still there for the right one.
    const wrong = await getPool().query(CONSUME_HANDOFF, [handoffId, 'https://app.testbrand.example'])
    expect(wrong.rowCount).toBe(0)

    const a = await getClient()
    const b = await getClient()
    try {
      const [ra, rb] = await Promise.all([
        a.query(CONSUME_HANDOFF, [handoffId, 'https://brand.testbrand.example']),
        b.query(CONSUME_HANDOFF, [handoffId, 'https://brand.testbrand.example']),
      ])
      expect(ra.rowCount! + rb.rowCount!).toBe(1)
      const winner = ra.rowCount === 1 ? ra : rb
      expect(winner.rows[0]!.handoff_code).toBe('v1:ciphertext')
    } finally {
      a.release()
      b.release()
    }

    // DELETE RETURNING: the held code left the database with the claim.
    const gone = await getPool().query('SELECT 1 FROM public.oauth_flows WHERE id = $1', [id])
    expect(gone.rowCount).toBe(0)
  })

  it('refuses an expired handoff', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertFlow({ companyId, userId, origin: 'https://brand.testbrand.example' })
    await getPool().query(CONSUME_STATE, [id])
    const handoffId = await mintHandoff(id, -1)
    const res = await getPool().query(CONSUME_HANDOFF, [handoffId, 'https://brand.testbrand.example'])
    expect(res.rowCount).toBe(0)
  })

  it('rejects a handoff written onto an unconsumed state', async () => {
    // The shape constraint: a handoff only exists for a state hop 1 consumed,
    // so a stray write can never make an unconsumed state claimable twice.
    const { companyId, userId } = await seedCompany()
    const id = await insertFlow({ companyId, userId })
    await expect(
      getPool().query(
        `UPDATE public.oauth_flows
            SET handoff_id = 'h', handoff_code = 'v1:x', handoff_expires_at = now() + interval '2 minutes'
          WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/oauth_flows_handoff_shape/)
  })
})
