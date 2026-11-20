import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from './setup'
import { seedCompany } from './fixtures'

/**
 * A way out of possible_duplicate for a collections payout
 * (20261021120300_collection_settlement_duplicate_resolution.sql): a payout
 * marked handled elsewhere carries its reason, who and when; a confirmation
 * that it is not a duplicate carries who and when; and the database writes
 * each decision to audit_log with the person, whatever path made it, and
 * nothing for ordinary booking churn.
 */

async function heldPayout() {
  const seed = await seedCompany()
  const { rows: connection } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_connections
       (company_id, user_id, route, provider_ref, display_name, state,
        catalogue_terms_version, consented_by, consented_at, activated_at, ladder_mode)
     VALUES ($1, $2, 'connect', 'acme-inkasso', 'Acme Inkasso', 'active', 'v1', $2, now(), now(), 'off')
     RETURNING id`,
    [seed.companyId, seed.userId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.collection_settlements
       (company_id, connection_id, provider_settlement_ref, payment_date, amount, currency, provider_status_ok,
        status, needs_mapping_reason)
     VALUES ($1, $2, $3, '2026-07-05', 875, 'SEK', true, 'needs_mapping', 'possible_duplicate')
     RETURNING id`,
    [seed.companyId, connection[0]!.id, `stl-${randomUUID()}`],
  )
  return { ...seed, settlementId: rows[0]!.id }
}

async function auditRows(recordId: string) {
  const { rows } = await getPool().query<{ user_id: string; actor_id: string; action: string; table_name: string; description: string; new_state: Record<string, unknown> }>(
    `SELECT user_id, actor_id, action, table_name, description, new_state FROM public.audit_log WHERE record_id = $1 ORDER BY created_at`,
    [recordId],
  )
  return rows
}

function update(sql: string, params: unknown[]) {
  return runAsServiceRole((client) => client.query(sql, params))
}

describe('collection_settlements: possible duplicate resolution (pg)', () => {
  it('marks a payout handled elsewhere only with a reason, who and when, and audits it with the person', async () => {
    const p = await heldPayout()
    await expect(
      update(`UPDATE public.collection_settlements SET status = 'ignored' WHERE id = $1`, [p.settlementId]),
    ).rejects.toThrow(/collection_settlements_ignored_shape/)
    await expect(
      update(`UPDATE public.collection_settlements SET status = 'ignored', ignored_reason = '   ', ignored_by = $2, ignored_at = now() WHERE id = $1`, [
        p.settlementId,
        p.userId,
      ]),
    ).rejects.toThrow(/ignored_reason/)
    expect(await auditRows(p.settlementId)).toEqual([])

    await update(
      `UPDATE public.collection_settlements SET status = 'ignored', ignored_reason = 'Bokförd för hand', ignored_by = $2, ignored_at = now() WHERE id = $1`,
      [p.settlementId, p.userId],
    )
    const audit = await auditRows(p.settlementId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      user_id: p.userId,
      actor_id: p.userId,
      action: 'UPDATE',
      table_name: 'collection_settlements',
      description: 'Collections payout marked as handled elsewhere: Bokförd för hand',
      new_state: expect.objectContaining({ status: 'ignored', ignored_reason: 'Bokförd för hand', amount: 875 }),
    })
  })

  it('confirms not a duplicate only with who and when, audits it once, and nothing for other updates', async () => {
    const p = await heldPayout()
    await expect(
      update(`UPDATE public.collection_settlements SET duplicate_cleared_by = $2 WHERE id = $1`, [p.settlementId, p.userId]),
    ).rejects.toThrow(/collection_settlements_duplicate_cleared_shape/)

    await update(`UPDATE public.collection_settlements SET booking_lease_until = now() + interval '1 minute' WHERE id = $1`, [p.settlementId])
    expect(await auditRows(p.settlementId)).toEqual([])

    await update(`UPDATE public.collection_settlements SET duplicate_cleared_by = $2, duplicate_cleared_at = now() WHERE id = $1`, [
      p.settlementId,
      p.userId,
    ])
    await update(`UPDATE public.collection_settlements SET booking_lease_until = NULL WHERE id = $1`, [p.settlementId])
    const audit = await auditRows(p.settlementId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      user_id: p.userId,
      description: 'Collections payout confirmed as not a duplicate of a voucher booked by hand',
    })
  })

  it('keeps the trigger function out of reach of signed-in roles', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean }>(
      `SELECT has_function_privilege('anon', 'public.audit_collection_settlement_decision()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.audit_collection_settlement_decision()', 'EXECUTE') AS authenticated`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false })
  })
})
