import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

// pg-real for migration 20260831200000: the connection ledger, the global
// upstream budget RPC, and validate v2 returning limits. Service-role-only
// exposure is asserted the same way as the base connector-keys test.

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function insertKey(limits?: Record<string, number>): Promise<{ id: string; hash: string }> {
  const key = `gnubok_ck_${randomBytes(16).toString('base64url')}`
  const h = hash(key)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.connector_keys (key_hash, key_prefix, org_number, scopes, status${limits ? ', limits' : ''})
     VALUES ($1, $2, '5561234567', ARRAY['bank_sync','skatteverket'], 'active'${limits ? ', $3' : ''})
     RETURNING id`,
    limits ? [h, key.slice(0, 18), JSON.stringify(limits)] : [h, key.slice(0, 18)],
  )
  return { id: rows[0].id, hash: h }
}

describe('validate_and_increment_connector_key v2', () => {
  it('returns the key limits (default when unset)', async () => {
    const { hash: h } = await insertKey()
    const { rows } = await getPool().query(`SELECT * FROM public.validate_and_increment_connector_key($1)`, [h])
    expect(rows[0].limits).toEqual({ bank_connections_per_company: 1, skv_connections_per_company: 1, peppol_connections_per_company: 1, sync_min_interval_s: 0 })
  })

  it('returns custom limits verbatim', async () => {
    const { hash: h } = await insertKey({ bank_connections_per_company: 3, skv_connections_per_company: 2, sync_min_interval_s: 1800 })
    const { rows } = await getPool().query(`SELECT * FROM public.validate_and_increment_connector_key($1)`, [h])
    expect(rows[0].limits).toEqual({ bank_connections_per_company: 3, skv_connections_per_company: 2, sync_min_interval_s: 1800 })
  })
})

describe('connector_reserve_upstream', () => {
  it('reserves under the ceiling and rejects over it, service-scoped', async () => {
    const svc = `bank-${randomBytes(4).toString('hex')}`
    const call = async () => {
      const { rows } = await getPool().query(`SELECT public.connector_reserve_upstream($1, 2, 100) AS r`, [svc])
      return rows[0].r as { ok: boolean; scope?: string }
    }
    expect((await call()).ok).toBe(true)
    expect((await call()).ok).toBe(true)
    const third = await call()
    expect(third.ok).toBe(false)
    expect(third.scope).toBe('minute')
    // A different service has its own budget.
    const { rows } = await getPool().query(`SELECT public.connector_reserve_upstream($1, 2, 100) AS r`, [`skv-${randomBytes(4).toString('hex')}`])
    expect((rows[0].r as { ok: boolean }).ok).toBe(true)
  })

  it('is executable by service_role only', async () => {
    const { rows } = await getPool().query<{ role: string; ok: boolean }>(
      `SELECT r.role, has_function_privilege(r.role, 'public.connector_reserve_upstream(text,integer,integer)', 'execute') AS ok
         FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)`,
    )
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({ anon: false, authenticated: false, service_role: true })
  })
})

describe('connector_connections ledger', () => {
  it('accepts peppol as a ledger service (migration 20260902190000)', async () => {
    const { id: keyId } = await insertKey()
    const participant = `0007:${randomBytes(6).toString('hex')}`
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.connector_connections (connector_key_id, service, company_ref, handle_hash, account_uids, status)
       VALUES ($1, 'peppol', 'c1', $2, ARRAY[$3::text], 'active') RETURNING id`,
      [keyId, hash(participant), participant],
    )
    expect(rows[0].id).toBeTruthy()
    await expect(
      getPool().query(
        `INSERT INTO public.connector_connections (connector_key_id, service, company_ref, status) VALUES ($1, 'kivra', 'c1', 'pending')`,
        [keyId],
      ),
    ).rejects.toThrow(/connector_connections_service_check|check constraint/)
  })

  it('enforces the handle uniqueness per service and cascades with the key', async () => {
    const { id: keyId } = await insertKey()
    await getPool().query(
      `INSERT INTO public.connector_connections (connector_key_id, service, company_ref, handle_hash, status)
       VALUES ($1, 'bank', 'c1', $2, 'active')`,
      [keyId, hash('sess-1')],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.connector_connections (connector_key_id, service, company_ref, handle_hash, status)
         VALUES ($1, 'bank', 'c2', $2, 'active')`,
        [keyId, hash('sess-1')],
      ),
    ).rejects.toThrow(/idx_connector_connections_handle|duplicate key/)
    await getPool().query(`DELETE FROM public.connector_keys WHERE id = $1`, [keyId])
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.connector_connections WHERE connector_key_id = $1`, [keyId])
    expect(rows[0].n).toBe(0)
  })

  it('is invisible to an authenticated user (service-role only)', async () => {
    const { id: keyId } = await insertKey()
    await getPool().query(
      `INSERT INTO public.connector_connections (connector_key_id, service, company_ref, status) VALUES ($1, 'bank', 'c1', 'pending')`,
      [keyId],
    )
    const userId = await insertAuthUser()
    await withUserContext(userId, async (client) => {
      const r = await client.query(`SELECT id FROM public.connector_connections`)
      expect(r.rowCount).toBe(0)
    })
  })
})

describe('connector_peppol_submissions (migration 20260902190000)', () => {
  it('is unique per provider submission, cascades with the key, and is invisible to authenticated', async () => {
    const { id: keyId } = await insertKey()
    const submissionId = `int-${randomBytes(6).toString('hex')}`
    await getPool().query(
      `INSERT INTO public.connector_peppol_submissions (connector_key_id, company_ref, provider_submission_id, idempotency_key)
       VALUES ($1, 'c1', $2, 'idem-1')`,
      [keyId, submissionId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.connector_peppol_submissions (connector_key_id, company_ref, provider_submission_id) VALUES ($1, 'c2', $2)`,
        [keyId, submissionId],
      ),
    ).rejects.toThrow(/connector_peppol_submissions_provider_submission_unique|duplicate key/)
    const userId = await insertAuthUser()
    await withUserContext(userId, async (client) => {
      const r = await client.query(`SELECT id FROM public.connector_peppol_submissions`)
      expect(r.rows).toEqual([])
    })
    await getPool().query(`DELETE FROM public.connector_keys WHERE id = $1`, [keyId])
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.connector_peppol_submissions WHERE connector_key_id = $1`, [keyId])
    expect(rows[0].n).toBe(0)
  })
})
