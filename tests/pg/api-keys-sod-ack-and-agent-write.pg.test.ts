import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for migration 20260619140000_api_keys_sod_ack_and_agent_write.
 *
 * Locks in:
 *   - The two SoD-acknowledgement columns exist with the expected types and
 *     the sod_acknowledged_by FK targets auth.users(id).
 *   - The grandfather UPDATE shipped agent:write onto every non-revoked key
 *     that already carried an explicit scope list (idempotent — running it
 *     again adds no duplicate).
 *   - NULL-scopes (legacy full/default access) and revoked keys were left
 *     untouched.
 *
 * Inserts go through the pool (superuser, RLS-bypassing) — this is a schema /
 * data-migration smoke, not an RLS test.
 */

async function insertApiKey(params: {
  userId: string
  companyId: string
  scopes: string[] | null
  revoked?: boolean
}): Promise<string> {
  const id = randomUUID()
  const hash = randomUUID().replace(/-/g, '').padEnd(64, '0')
  await getPool().query(
    `INSERT INTO public.api_keys
       (id, user_id, company_id, key_hash, key_prefix, name, scopes, revoked_at)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'pg-real key', $5, $6)`,
    [
      id,
      params.userId,
      params.companyId,
      hash,
      params.scopes,
      params.revoked ? new Date() : null,
    ],
  )
  return id
}

async function scopesOf(id: string): Promise<string[] | null> {
  const { rows } = await getPool().query<{ scopes: string[] | null }>(
    `SELECT scopes FROM public.api_keys WHERE id = $1`,
    [id],
  )
  return rows[0]?.scopes ?? null
}

describe('api_keys SoD-ack columns + agent:write grandfathering', () => {
  it('exposes sod_acknowledged_at / sod_acknowledged_by with the expected shape', async () => {
    const { rows } = await getPool().query<{
      column_name: string
      data_type: string
    }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'api_keys'
         AND column_name IN ('sod_acknowledged_at', 'sod_acknowledged_by')
       ORDER BY column_name`,
    )
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]))
    expect(byName['sod_acknowledged_at']).toBe('timestamp with time zone')
    expect(byName['sod_acknowledged_by']).toBe('uuid')
  })

  it('sod_acknowledged_by references auth.users(id)', async () => {
    // pg_constraint, not information_schema: the constraint crosses schemas
    // (public → auth) and information_schema's constraint_column_usage hides
    // referenced tables outside the constrained table's schema.
    const { rows } = await getPool().query<{ foreign_table: string }>(
      `SELECT c.confrelid::regclass::text AS foreign_table
       FROM pg_constraint c
       JOIN pg_attribute a
         ON a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'public.api_keys'::regclass
         AND c.contype = 'f'
         AND a.attname = 'sod_acknowledged_by'`,
    )
    expect(rows[0]?.foreign_table).toBe('auth.users')
  })

  it('accepts a write that records the SoD acknowledgement', async () => {
    const { userId, companyId } = await seedCompany()
    const keyId = await insertApiKey({
      userId,
      companyId,
      scopes: ['invoices:write', 'pending_operations:approve'],
    })

    await getPool().query(
      `UPDATE public.api_keys
       SET sod_acknowledged_at = now(), sod_acknowledged_by = $2
       WHERE id = $1`,
      [keyId, userId],
    )

    const { rows } = await getPool().query<{
      sod_acknowledged_at: string | null
      sod_acknowledged_by: string | null
    }>(
      `SELECT sod_acknowledged_at, sod_acknowledged_by
       FROM public.api_keys WHERE id = $1`,
      [keyId],
    )
    expect(rows[0]?.sod_acknowledged_at).not.toBeNull()
    expect(rows[0]?.sod_acknowledged_by).toBe(userId)
  })

  it('rejects a partial SoD acknowledgement (paired-NULL CHECK)', async () => {
    const { userId, companyId } = await seedCompany()
    const keyId = await insertApiKey({
      userId,
      companyId,
      scopes: ['invoices:write', 'pending_operations:approve'],
    })

    // Timestamp without acknowledger — the audit pair must be both-or-neither.
    await expect(
      getPool().query(
        `UPDATE public.api_keys SET sod_acknowledged_at = now() WHERE id = $1`,
        [keyId],
      ),
    ).rejects.toMatchObject({ code: '23514' }) // check_violation

    // Acknowledger without timestamp — equally rejected.
    await expect(
      getPool().query(
        `UPDATE public.api_keys SET sod_acknowledged_by = $2 WHERE id = $1`,
        [keyId, userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('grandfather UPDATE adds agent:write to scoped, non-revoked keys (idempotent)', async () => {
    const { userId, companyId } = await seedCompany()
    // Mimic a pre-migration key created with an explicit scope list but WITHOUT
    // agent:write (the column existed before this migration).
    const keyId = await insertApiKey({
      userId,
      companyId,
      scopes: ['transactions:read', 'reports:read'],
    })

    // Re-run the migration's grandfather statement; it must be idempotent.
    const run = () =>
      getPool().query(
        `UPDATE public.api_keys
         SET scopes = array_append(scopes, 'agent:write')
         WHERE id = $1
           AND revoked_at IS NULL
           AND scopes IS NOT NULL
           AND NOT ('agent:write' = ANY(scopes))`,
        [keyId],
      )
    await run()
    await run()

    const scopes = await scopesOf(keyId)
    expect(scopes).toContain('agent:write')
    expect(scopes?.filter((s) => s === 'agent:write')).toHaveLength(1)
  })

  it('leaves NULL-scopes and revoked keys untouched', async () => {
    const { userId, companyId } = await seedCompany()
    const nullKey = await insertApiKey({ userId, companyId, scopes: null })
    const revokedKey = await insertApiKey({
      userId,
      companyId,
      scopes: ['transactions:read'],
      revoked: true,
    })

    await getPool().query(
      `UPDATE public.api_keys
       SET scopes = array_append(scopes, 'agent:write')
       WHERE id = ANY($1::uuid[])
         AND revoked_at IS NULL
         AND scopes IS NOT NULL
         AND NOT ('agent:write' = ANY(scopes))`,
      [[nullKey, revokedKey]],
    )

    expect(await scopesOf(nullKey)).toBeNull()
    expect(await scopesOf(revokedKey)).toEqual(['transactions:read'])
  })
})
