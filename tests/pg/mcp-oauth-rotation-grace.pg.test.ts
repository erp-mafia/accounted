import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20260621130000_api_keys_rotation_grace.
 *
 * Locks in the issue #710 fix:
 *   - The four previous_* shadow columns exist.
 *   - validate_and_increment_api_key accepts the current key_hash OR an
 *     unexpired previous_key_hash (access-token grace), rejects an expired one,
 *     never matches a revoked key, and increments the rate-limit counter on the
 *     resolved row even when matched via the grace hash.
 *   - rotate_mcp_refresh_token: 'rotated' demotes the consumed pair to previous_*;
 *     presenting the previous refresh token within grace 'replayed's (re-issues
 *     + slides the window); reuse AFTER grace is 'reuse_revoked' and sets
 *     revoked_at (RFC 9700 §4.14.2); unknown → 'invalid'; revoked grant → 'revoked'.
 *
 * Inserts go through the pool (superuser, RLS-bypassing): this is an RPC /
 * schema behaviour test, not an RLS test. Hashes are opaque text the RPCs
 * compare by equality, so any unique strings work.
 */

type KeyRow = {
  key_hash: string
  refresh_token_hash: string | null
  previous_key_hash?: string | null
  previous_key_expires_at?: string | null
  previous_refresh_token_hash?: string | null
  previous_refresh_expires_at?: string | null
  scopes?: string[] | null
  revoked?: boolean
}

function h(label: string): string {
  // Opaque 64-char unique hash-shaped string.
  return `${label}_${randomUUID().replace(/-/g, '')}`.padEnd(64, '0').slice(0, 64)
}

async function insertKey(
  userId: string,
  companyId: string,
  row: KeyRow,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.api_keys
       (id, user_id, company_id, key_hash, key_prefix, name, scopes,
        refresh_token_hash, previous_key_hash, previous_key_expires_at,
        previous_refresh_token_hash, previous_refresh_expires_at, revoked_at)
     VALUES ($1,$2,$3,$4,'gnubok_sk_test','pg-real oauth key',$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      userId,
      companyId,
      row.key_hash,
      row.scopes ?? null,
      row.refresh_token_hash ?? null,
      row.previous_key_hash ?? null,
      row.previous_key_expires_at ?? null,
      row.previous_refresh_token_hash ?? null,
      row.previous_refresh_expires_at ?? null,
      row.revoked ? new Date() : null,
    ],
  )
  return id
}

async function validate(keyHash: string) {
  const { rows } = await getPool().query(
    `SELECT * FROM public.validate_and_increment_api_key($1)`,
    [keyHash],
  )
  return rows
}

async function rotate(
  presented: string,
  newRefresh: string,
  newKey: string,
  graceSeconds = 120,
) {
  const { rows } = await getPool().query<{ outcome: string; scopes: string[] | null }>(
    `SELECT * FROM public.rotate_mcp_refresh_token($1,$2,$3,'gnubok_sk_new',$4)`,
    [presented, newRefresh, newKey, graceSeconds],
  )
  return rows[0]
}

async function rowById(id: string) {
  const { rows } = await getPool().query(
    `SELECT key_hash, refresh_token_hash, previous_key_hash, previous_key_expires_at,
            previous_refresh_token_hash, previous_refresh_expires_at, revoked_at, request_count
     FROM public.api_keys WHERE id = $1`,
    [id],
  )
  return rows[0]
}

describe('api_keys rotation grace (issue #710)', () => {
  it('adds the four previous_* shadow columns', async () => {
    const { rows } = await getPool().query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='public' AND table_name='api_keys'
         AND column_name IN ('previous_key_hash','previous_key_expires_at',
                             'previous_refresh_token_hash','previous_refresh_expires_at')
       ORDER BY column_name`,
    )
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]))
    expect(byName['previous_key_hash']).toBe('text')
    expect(byName['previous_key_expires_at']).toBe('timestamp with time zone')
    expect(byName['previous_refresh_token_hash']).toBe('text')
    expect(byName['previous_refresh_expires_at']).toBe('timestamp with time zone')
  })

  describe('validate_and_increment_api_key access-token grace', () => {
    it('accepts the current key_hash', async () => {
      const { userId, companyId } = await seedCompany()
      const cur = h('cur')
      await insertKey(userId, companyId, { key_hash: cur, refresh_token_hash: h('rt') })
      const rows = await validate(cur)
      expect(rows).toHaveLength(1)
      expect(rows[0].user_id).toBe(userId)
      expect(rows[0].rate_limited).toBe(false)
    })

    it('accepts an unexpired previous_key_hash and increments the resolved row', async () => {
      const { userId, companyId } = await seedCompany()
      const cur = h('cur')
      const prev = h('prev')
      const id = await insertKey(userId, companyId, {
        key_hash: cur,
        refresh_token_hash: h('rt'),
        previous_key_hash: prev,
        previous_key_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      // Two grace-hash validations: window resets to 1, then increments to 2:
      // proving the increment is keyed off the resolved row id, not p_key_hash.
      expect(await validate(prev)).toHaveLength(1)
      expect(await validate(prev)).toHaveLength(1)
      expect((await rowById(id)).request_count).toBe(2)
    })

    it('rejects an expired previous_key_hash but still accepts the current one', async () => {
      const { userId, companyId } = await seedCompany()
      const cur = h('cur')
      const prev = h('prev')
      await insertKey(userId, companyId, {
        key_hash: cur,
        refresh_token_hash: h('rt'),
        previous_key_hash: prev,
        previous_key_expires_at: new Date(Date.now() - 1_000).toISOString(),
      })
      expect(await validate(prev)).toHaveLength(0)
      expect(await validate(cur)).toHaveLength(1)
    })

    it('never matches a revoked key (current or previous)', async () => {
      const { userId, companyId } = await seedCompany()
      const cur = h('cur')
      const prev = h('prev')
      await insertKey(userId, companyId, {
        key_hash: cur,
        refresh_token_hash: h('rt'),
        previous_key_hash: prev,
        previous_key_expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked: true,
      })
      expect(await validate(cur)).toHaveLength(0)
      expect(await validate(prev)).toHaveLength(0)
    })
  })

  describe('rotate_mcp_refresh_token', () => {
    it('rotates a current refresh token and demotes the consumed pair to previous_*', async () => {
      const { userId, companyId } = await seedCompany()
      const r1 = h('r1')
      const k1 = h('k1')
      const id = await insertKey(userId, companyId, {
        key_hash: k1,
        refresh_token_hash: r1,
        scopes: ['transactions:read', 'invoices:read'],
      })
      const r2 = h('r2')
      const k2 = h('k2')
      const res = await rotate(r1, r2, k2)
      expect(res.outcome).toBe('rotated')
      expect(res.scopes).toEqual(['transactions:read', 'invoices:read'])

      const row = await rowById(id)
      expect(row.refresh_token_hash).toBe(r2)
      expect(row.key_hash).toBe(k2)
      expect(row.previous_refresh_token_hash).toBe(r1)
      expect(row.previous_key_hash).toBe(k1)
      expect(new Date(row.previous_refresh_expires_at).getTime()).toBeGreaterThan(Date.now())
      expect(new Date(row.previous_key_expires_at).getTime()).toBeGreaterThan(Date.now())

      // The just-superseded access key still validates within grace.
      expect(await validate(k1)).toHaveLength(1)
    })

    it("replays idempotently when the PREVIOUS refresh token is presented within grace (issue #710)", async () => {
      const { userId, companyId } = await seedCompany()
      const r1 = h('r1')
      const k1 = h('k1')
      const id = await insertKey(userId, companyId, {
        key_hash: k1,
        refresh_token_hash: r1,
        scopes: ['reports:read'],
      })
      // First, a normal rotation r1 -> r2 (client receives r2 but mis-persists,
      // keeping r1).
      expect((await rotate(r1, h('r2'), h('k2'))).outcome).toBe('rotated')

      // Client retries with the stale r1: must NOT 400; it replays and gets a
      // fresh current pair, and the grace window slides.
      const r3 = h('r3')
      const k3 = h('k3')
      const replay = await rotate(r1, r3, k3)
      expect(replay.outcome).toBe('replayed')
      expect(replay.scopes).toEqual(['reports:read'])

      const row = await rowById(id)
      expect(row.refresh_token_hash).toBe(r3)
      expect(row.key_hash).toBe(k3)
      expect(row.previous_refresh_token_hash).toBe(r1) // preserved, not chained
      expect(row.revoked_at).toBeNull()
    })

    it('treats reuse of a previous refresh token AFTER the grace window as a breach and revokes the grant', async () => {
      const { userId, companyId } = await seedCompany()
      const r1 = h('r1')
      const k1 = h('k1')
      const id = await insertKey(userId, companyId, { key_hash: k1, refresh_token_hash: r1 })
      expect((await rotate(r1, h('r2'), h('k2'))).outcome).toBe('rotated')

      // Force the previous-refresh grace to have expired.
      await getPool().query(
        `UPDATE public.api_keys SET previous_refresh_expires_at = now() - interval '1 second' WHERE id = $1`,
        [id],
      )

      const res = await rotate(r1, h('r3'), h('k3'))
      expect(res.outcome).toBe('reuse_revoked')

      const row = await rowById(id)
      expect(row.revoked_at).not.toBeNull()
      // The whole grant family is dead: neither current nor previous validates.
      expect(await validate(row.key_hash)).toHaveLength(0)
    })

    it("returns 'invalid' for an unknown refresh token", async () => {
      const res = await rotate(h('nope'), h('r2'), h('k2'))
      expect(res.outcome).toBe('invalid')
    })

    it("returns 'revoked' when the matched grant is already revoked", async () => {
      const { userId, companyId } = await seedCompany()
      const r1 = h('r1')
      await insertKey(userId, companyId, {
        key_hash: h('k1'),
        refresh_token_hash: r1,
        revoked: true,
      })
      const res = await rotate(r1, h('r2'), h('k2'))
      expect(res.outcome).toBe('revoked')
    })
  })
})
