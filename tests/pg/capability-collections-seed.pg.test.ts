import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { PAID_CAPABILITIES, PAID_PLAN_ONLY_CAPABILITIES, TRIAL_CAPABILITIES } from '@/lib/entitlements/keys'

// The collections capability is PAID-PLAN ONLY (founder decision 2026-10-04):
// the company-creation trial never seeds it, and the backfill in
// 20261004044900_collections_capability_backfill.sql mirrors only the paid and
// operator sources of each email_send grant (stripe, manual, comp), never a
// trial or a connector row.

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../supabase/migrations/20261004044900_collections_capability_backfill.sql',
)

async function grantKeys(companyId: string, source?: string): Promise<string[]> {
  const { rows } = await getPool().query<{ capability_key: string }>(
    `SELECT capability_key FROM public.capability_grants
     WHERE company_id = $1 AND ($2::text IS NULL OR source = $2)
     ORDER BY capability_key`,
    [companyId, source ?? null],
  )
  return rows.map((r) => r.capability_key)
}

async function hasCapability(client: PoolClient | null, companyId: string, key: string): Promise<boolean> {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{ ok: boolean }>(`SELECT public.company_has_capability($1, $2) AS ok`, [
    companyId,
    key,
  ])
  return rows[0].ok
}

describe('collections capability: never trial-seeded', () => {
  it('is paid, and paid-plan only', () => {
    expect(PAID_CAPABILITIES).toContain('collections')
    expect(PAID_PLAN_ONLY_CAPABILITIES).toContain('collections')
    expect(TRIAL_CAPABILITIES).not.toContain('collections')
  })

  it('a new company gets the trial keys and no collections grant from any source', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    expect(await grantKeys(companyId, 'trial')).toEqual([...TRIAL_CAPABILITIES].sort())
    expect(await grantKeys(companyId)).not.toContain('collections')
    expect(await hasCapability(null, companyId, 'collections')).toBe(false)
    // The trial still unlocks the rest of the paid set.
    expect(await hasCapability(null, companyId, 'email_send')).toBe(true)
  })

  it('a company created under a byrå team gets no collections grant either', async () => {
    const owner = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(`INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`, [
      teamId,
      owner,
    ])
    const companyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.companies (id, name, entity_type, created_by, team_id)
       VALUES ($1, 'Klient AB', 'aktiebolag', $2, $3)`,
      [companyId, owner, teamId],
    )
    expect(await grantKeys(companyId)).toEqual([])
  })
})

describe('20261004044900 backfill: mirrors only paid and operator email_send grants', () => {
  /** Run the migration inside a transaction that is rolled back, so no other test file sees its rows. */
  async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await fn(client)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }

  async function companyWithoutGrants(client: PoolClient, userId: string, teamId: string | null = null): Promise<string> {
    const id = randomUUID()
    await client.query(
      `INSERT INTO public.companies (id, name, entity_type, created_by, team_id) VALUES ($1, 'Backfill AB', 'aktiebolag', $2, $3)`,
      [id, userId, teamId],
    )
    await client.query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [id])
    return id
  }

  async function grant(
    client: PoolClient,
    p: { companyId?: string | null; teamId?: string | null; source: string; expiresAt: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.capability_grants (company_id, team_id, capability_key, source, expires_at)
       VALUES ($1, $2, 'email_send', $3, $4)`,
      [p.companyId ?? null, p.teamId ?? null, p.source, p.expiresAt],
    )
  }

  async function collectionsRows(client: PoolClient, where: { companyId?: string; teamId?: string }) {
    const { rows } = await client.query<{
      source: string
      expires_at: Date | null
      company_id: string | null
      team_id: string | null
      metadata: Record<string, unknown>
    }>(
      `SELECT source, expires_at, company_id, team_id, metadata FROM public.capability_grants
       WHERE capability_key = 'collections'
         AND (($1::uuid IS NOT NULL AND company_id = $1) OR ($2::uuid IS NOT NULL AND team_id = $2))
       ORDER BY source`,
      [where.companyId ?? null, where.teamId ?? null],
    )
    return rows
  }

  it('copies stripe, manual (team-scoped too) and comp rows with their expiry; skips trial and connector rows', async () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    await inRolledBackTransaction(async (client) => {
      const userId = await insertAuthUser()
      const periodEnd = '2099-01-04T00:00:00.000Z'

      const stripeCo = await companyWithoutGrants(client, userId)
      await grant(client, { companyId: stripeCo, source: 'stripe', expiresAt: periodEnd })

      const compCo = await companyWithoutGrants(client, userId)
      await grant(client, { companyId: compCo, source: 'comp', expiresAt: null })

      const trialCo = await companyWithoutGrants(client, userId)
      await grant(client, { companyId: trialCo, source: 'trial', expiresAt: periodEnd })

      const connectorCo = await companyWithoutGrants(client, userId)
      await grant(client, { companyId: connectorCo, source: 'connector', expiresAt: periodEnd })

      const teamId = randomUUID()
      await client.query(`INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`, [
        teamId,
        userId,
      ])
      await grant(client, { teamId, source: 'manual', expiresAt: null })
      const teamClient = await companyWithoutGrants(client, userId, teamId)

      await client.query(sql)

      const stripeRows = await collectionsRows(client, { companyId: stripeCo })
      expect(stripeRows).toHaveLength(1)
      expect(stripeRows[0].source).toBe('stripe')
      expect(stripeRows[0].expires_at?.toISOString()).toBe(periodEnd)
      expect(stripeRows[0].metadata).toEqual({ backfilled_from: 'email_send', backfill_migration: '20261004044900' })
      expect(await hasCapability(client, stripeCo, 'collections')).toBe(true)

      const compRows = await collectionsRows(client, { companyId: compCo })
      expect(compRows.map((r) => [r.source, r.expires_at])).toEqual([['comp', null]])

      const teamRows = await collectionsRows(client, { teamId })
      expect(teamRows.map((r) => [r.source, r.company_id, r.team_id])).toEqual([['manual', null, teamId]])
      // The team grant cascades to the byrå's client company.
      expect(await hasCapability(client, teamClient, 'collections')).toBe(true)

      expect(await collectionsRows(client, { companyId: trialCo })).toEqual([])
      expect(await hasCapability(client, trialCo, 'collections')).toBe(false)
      expect(await collectionsRows(client, { companyId: connectorCo })).toEqual([])

      // Re-running is a no-op (ON CONFLICT DO NOTHING on the grant key).
      await client.query(sql)
      expect(await collectionsRows(client, { companyId: stripeCo })).toHaveLength(1)
    })
  })
})
