import { createHash, randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20261025084800_mcp_oauth_refresh_idempotent_replay
 * (crm#1043): a retried refresh no longer revokes the connection.
 *
 * The grant's state decides, not a 120 s clock:
 *   - the current refresh token rotates;
 *   - its immediate predecessor (successor not used yet) gets the SAME
 *     successor again, however late, and the first answer stays live;
 *   - a token presented after its successor was used (two or more
 *     generations old) revokes the grant;
 *   - a pair rotated before the migration (not the presented token's derived
 *     successor) is replaced once by the derived pair.
 *
 * The token endpoint derives the successor pair from the presented token
 * (deriveRotatedCredentials); here `successorOf` stands in for it, since the
 * RPC only compares opaque hashes. Calls run as service_role, like the route.
 */

type Pair = { refresh: string; key: string }

function sha(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

function token(label: string): string {
  return sha(`${label}:${randomUUID()}`)
}

/** Deterministic successor of a refresh-token hash, as the route derives it. */
function successorOf(refreshHash: string): Pair {
  return { refresh: sha(`refresh:${refreshHash}`), key: sha(`access:${refreshHash}`) }
}

async function insertGrant(opts: {
  refresh: string
  key: string
  previousRefresh?: string | null
  scopes?: string[] | null
  revoked?: boolean
}): Promise<string> {
  const { userId, companyId } = await seedCompany()
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.api_keys
       (id, user_id, company_id, key_hash, key_prefix, name, scopes,
        refresh_token_hash, previous_refresh_token_hash, revoked_at)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'MCP-klient (OAuth)', $5, $6, $7, $8)`,
    [
      id,
      userId,
      companyId,
      opts.key,
      opts.scopes ?? null,
      opts.refresh,
      opts.previousRefresh ?? null,
      opts.revoked ? new Date() : null,
    ],
  )
  return id
}

type RotateResult = { outcome: string; scopes: string[] | null; api_key_id: string | null }

/** Present `presented` with the successor the route would derive for it. */
async function present(presented: string, pair: Pair = successorOf(presented)): Promise<RotateResult> {
  const { rows } = await runAsServiceRole((client) =>
    client.query<RotateResult>(
      `SELECT * FROM public.rotate_mcp_refresh_token($1, $2, $3, 'gnubok_sk_next', 120)`,
      [presented, pair.refresh, pair.key],
    ),
  )
  return rows[0]
}

async function grantRow(id: string) {
  const { rows } = await getPool().query(
    `SELECT key_hash, refresh_token_hash, previous_key_hash, previous_key_expires_at,
            previous_refresh_token_hash, previous_refresh_expires_at, revoked_at
     FROM public.api_keys WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function keyValidates(keyHash: string): Promise<boolean> {
  const { rows } = await runAsServiceRole((client) =>
    client.query(`SELECT * FROM public.validate_and_increment_api_key($1)`, [keyHash]),
  )
  return rows.length === 1
}

async function retiredRows(id: string): Promise<string[]> {
  const { rows } = await getPool().query<{ token_hash: string }>(
    `SELECT token_hash FROM public.api_key_retired_refresh_tokens WHERE api_key_id = $1 ORDER BY retired_at`,
    [id],
  )
  return rows.map((r) => r.token_hash)
}

describe('rotate_mcp_refresh_token: idempotent replay and reuse detection (crm#1043)', () => {
  it('rotates the current token and returns the grant id', async () => {
    const r1 = token('r1')
    const k1 = token('k1')
    const id = await insertGrant({ refresh: r1, key: k1, scopes: ['reports:read'] })

    const res = await present(r1)
    expect(res).toEqual({ outcome: 'rotated', scopes: ['reports:read'], api_key_id: id })

    const s1 = successorOf(r1)
    const row = await grantRow(id)
    expect(row.refresh_token_hash).toBe(s1.refresh)
    expect(row.key_hash).toBe(s1.key)
    expect(row.previous_refresh_token_hash).toBe(r1)
    expect(row.previous_refresh_expires_at).toBeNull()
    // The superseded access key keeps its grace for requests in flight.
    expect(row.previous_key_hash).toBe(k1)
    expect(new Date(row.previous_key_expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(await keyValidates(k1)).toBe(true)
    expect(await keyValidates(s1.key)).toBe(true)
  })

  it('answers a replay of the predecessor with the same successor, long after any grace window', async () => {
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    expect((await present(r1)).outcome).toBe('rotated')
    const s1 = successorOf(r1)

    // Days later: the old 120 s windows are long gone. The pre-crm#1043 RPC
    // revoked the grant here.
    await getPool().query(
      `UPDATE public.api_keys
          SET previous_key_expires_at = now() - interval '3 days',
              previous_refresh_expires_at = now() - interval '3 days'
        WHERE id = $1`,
      [id],
    )
    const before = await grantRow(id)

    const replay = await present(r1)
    expect(replay).toEqual({ outcome: 'replayed', scopes: null, api_key_id: id })

    // Nothing moved: the same pair is current, the token is still the
    // predecessor, and the grant is alive.
    const after = await grantRow(id)
    expect(after).toEqual(before)
    expect(after.refresh_token_hash).toBe(s1.refresh)
    expect(after.revoked_at).toBeNull()
    expect(await keyValidates(s1.key)).toBe(true)

    // And again: a replay is idempotent however often it arrives.
    expect((await present(r1)).outcome).toBe('replayed')
    expect(await grantRow(id)).toEqual(before)
  })

  it('keeps the first answer live after a replay: its successor still rotates', async () => {
    // Two concurrent refreshes: the first rotated, the second replayed. The
    // pre-crm#1043 RPC minted a different pair for the second and overwrote
    // the first, so a client that kept the first answer got 'invalid' next.
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    expect((await present(r1)).outcome).toBe('rotated')
    expect((await present(r1)).outcome).toBe('replayed')

    const s1 = successorOf(r1)
    const next = await present(s1.refresh)
    expect(next).toEqual({ outcome: 'rotated', scopes: null, api_key_id: id })
    expect((await grantRow(id)).refresh_token_hash).toBe(successorOf(s1.refresh).refresh)
  })

  it('serialises two truly concurrent refreshes of one token onto one successor', async () => {
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    const s1 = successorOf(r1)
    const call = `SELECT * FROM public.rotate_mcp_refresh_token($1, $2, $3, 'gnubok_sk_next', 120)`

    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      const first = await a.query<RotateResult>(call, [r1, s1.refresh, s1.key])
      expect(first.rows[0].outcome).toBe('rotated')
      // B blocks on A's row lock; once A commits, B re-reads the row, finds
      // r1 in the predecessor slot and gets the same pair back.
      const second = b.query<RotateResult>(call, [r1, s1.refresh, s1.key])
      await new Promise((resolve) => setTimeout(resolve, 100))
      await a.query('COMMIT')
      expect((await second).rows[0]).toEqual({ outcome: 'replayed', scopes: null, api_key_id: id })
    } finally {
      a.release()
      b.release()
    }

    const row = await grantRow(id)
    expect(row.refresh_token_hash).toBe(s1.refresh)
    expect(row.key_hash).toBe(s1.key)
    expect(row.revoked_at).toBeNull()
  })

  it('revokes the grant when a token is replayed after its successor was used', async () => {
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    expect((await present(r1)).outcome).toBe('rotated')
    const s1 = successorOf(r1)
    // The successor is used: r1 is now two generations behind.
    expect((await present(s1.refresh)).outcome).toBe('rotated')
    expect(await retiredRows(id)).toEqual([r1])

    const res = await present(r1)
    expect(res).toEqual({ outcome: 'reuse_revoked', scopes: null, api_key_id: id })

    const row = await grantRow(id)
    expect(row.revoked_at).not.toBeNull()
    // The whole grant family is dead: current access key and refresh token.
    expect(await keyValidates(row.key_hash)).toBe(false)
    expect((await present(row.refresh_token_hash)).outcome).toBe('revoked')
  })

  it('revokes the grant for a token several generations old', async () => {
    // The pre-crm#1043 RPC remembered one previous token only, so this was
    // 'invalid' and the grant (possibly held by whoever rotated it) lived on.
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    let current = r1
    for (let i = 0; i < 4; i++) {
      expect((await present(current)).outcome).toBe('rotated')
      current = successorOf(current).refresh
    }
    expect(await retiredRows(id)).toHaveLength(3)

    expect(await present(r1)).toEqual({ outcome: 'reuse_revoked', scopes: null, api_key_id: id })
    expect((await grantRow(id)).revoked_at).not.toBeNull()
    // Already revoked: a second old token reports it without revoking again.
    expect(await present(successorOf(r1).refresh)).toEqual({ outcome: 'revoked', scopes: null, api_key_id: id })
  })

  it('replaces a pre-migration successor once with the derived pair, then replays idempotently', async () => {
    // A grant rotated before this migration: the current pair was drawn at
    // random, so it is not the derived successor of its predecessor.
    const r1 = token('r1')
    const legacyRefresh = token('r2-random')
    const legacyKey = token('k2-random')
    const id = await insertGrant({ refresh: legacyRefresh, key: legacyKey, previousRefresh: r1 })

    const res = await present(r1)
    expect(res).toEqual({ outcome: 'replayed', scopes: null, api_key_id: id })

    const s1 = successorOf(r1)
    const row = await grantRow(id)
    expect(row.refresh_token_hash).toBe(s1.refresh)
    expect(row.key_hash).toBe(s1.key)
    expect(row.previous_refresh_token_hash).toBe(r1)
    // The replaced access key keeps the in-flight grace.
    expect(row.previous_key_hash).toBe(legacyKey)
    expect(new Date(row.previous_key_expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(row.revoked_at).toBeNull()

    // From now on the same token gets the same pair, with no write.
    expect((await present(r1)).outcome).toBe('replayed')
    expect(await grantRow(id)).toEqual(row)
  })

  it("reports 'revoked' for the current or previous token of a revoked grant", async () => {
    const r1 = token('r1')
    const r0 = token('r0')
    const id = await insertGrant({ refresh: r1, key: token('k1'), previousRefresh: r0, revoked: true })
    expect(await present(r1)).toEqual({ outcome: 'revoked', scopes: null, api_key_id: id })
    expect(await present(r0)).toEqual({ outcome: 'revoked', scopes: null, api_key_id: id })
  })

  it("reports 'invalid' with no grant id for an unknown token", async () => {
    expect(await present(token('nope'))).toEqual({ outcome: 'invalid', scopes: null, api_key_id: null })
  })

  it('prunes retired tokens older than 30 days on rotation', async () => {
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    const ancient = token('ancient')
    const recent = token('recent')
    await getPool().query(
      `INSERT INTO public.api_key_retired_refresh_tokens (token_hash, api_key_id, retired_at)
       VALUES ($1, $3, now() - interval '31 days'), ($2, $3, now() - interval '29 days')`,
      [ancient, recent, id],
    )
    expect((await present(r1)).outcome).toBe('rotated')
    expect(await retiredRows(id)).toEqual([recent])
  })

  it('keeps the retired-token table and the RPC out of reach of client roles', async () => {
    const { rows: table } = await getPool().query<{ rls: boolean; anon: boolean; auth: boolean; svc: boolean }>(
      `SELECT c.relrowsecurity AS rls,
              has_table_privilege('anon', c.oid, 'select') AS anon,
              has_table_privilege('authenticated', c.oid, 'select') AS auth,
              has_table_privilege('service_role', c.oid, 'select') AS svc
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'api_key_retired_refresh_tokens'`,
    )
    expect(table).toEqual([{ rls: true, anon: false, auth: false, svc: true }])

    const { rows: fn } = await getPool().query<{ anon: boolean; auth: boolean; svc: boolean; definer: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'execute') AS anon,
              has_function_privilege('authenticated', p.oid, 'execute') AS auth,
              has_function_privilege('service_role', p.oid, 'execute') AS svc,
              p.prosecdef AS definer
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rotate_mcp_refresh_token'`,
    )
    expect(fn).toEqual([{ anon: false, auth: false, svc: true, definer: true }])
  })

  it('drops the retired tokens with the grant', async () => {
    const r1 = token('r1')
    const id = await insertGrant({ refresh: r1, key: token('k1') })
    await present(r1)
    await present(successorOf(r1).refresh)
    expect(await retiredRows(id)).toHaveLength(1)
    await getPool().query(`DELETE FROM public.api_keys WHERE id = $1`, [id])
    expect(await retiredRows(id)).toEqual([])
  })
})
