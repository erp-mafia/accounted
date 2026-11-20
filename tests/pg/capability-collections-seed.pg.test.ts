import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { PAID_CAPABILITIES, PAID_PLAN_ONLY_CAPABILITIES, TRIAL_CAPABILITIES } from '@/lib/entitlements/keys'

// The collections capability was PAID-PLAN ONLY from 20261012030000 (product
// decision 2026-10-04): its backfill mirrored only the paid and operator
// sources of each email_send grant (stripe, manual, comp). Since
// 20261022120000 (product decision 2026-10-22) it is part of the trial: the
// company-creation trial seeds it, and that migration's backfill gives every
// running trial a collections grant ending with the trial.

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../supabase/migrations/20261012030000_collections_capability_backfill.sql',
)
const TRIAL_MIGRATION_PATH = path.resolve(__dirname, '../../supabase/migrations/20261022120000_collections_in_trial.sql')

async function grantKeys(companyId: string, source?: string): Promise<string[]> {
  const { rows } = await getPool().query<{ capability_key: string }>(
    `SELECT capability_key FROM public.capability_grants
     WHERE company_id = $1 AND ($2::text IS NULL OR source = $2)
     ORDER BY capability_key`,
    [companyId, source ?? null],
  )
  return rows.map((r) => r.capability_key)
}

// The capability gate's rule (lib/entitlements/has-capability.ts): an
// unexpired company or team grant from company_capability_grant_rows, and no
// company_capability_config row switching the key off.
async function hasCapability(client: PoolClient | null, companyId: string, key: string): Promise<boolean> {
  const runner = client ?? getPool()
  const { rows } = await runner.query<{ ok: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM public.company_capability_grant_rows($1, ARRAY[$2]::text[], false) g
              WHERE g.expires_at IS NULL OR g.expires_at > now()
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.company_capability_config c
              WHERE c.company_id = $1 AND c.capability_key = $2 AND c.enabled = false
            ) AS ok`,
    [companyId, key],
  )
  return rows[0].ok
}

describe('collections capability: part of the trial', () => {
  it('is paid, and in the trial', () => {
    expect(PAID_CAPABILITIES).toContain('collections')
    expect(PAID_PLAN_ONLY_CAPABILITIES).not.toContain('collections')
    expect(TRIAL_CAPABILITIES).toContain('collections')
  })

  it('a new company gets the trial keys, collections among them', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    expect(await grantKeys(companyId, 'trial')).toEqual([...TRIAL_CAPABILITIES].sort())
    expect(await grantKeys(companyId, 'trial')).toContain('collections')
    expect(await hasCapability(null, companyId, 'collections')).toBe(true)
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

describe('20261012030000 backfill: mirrors only paid and operator email_send grants', () => {
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
      expect(stripeRows[0].metadata).toEqual({ backfilled_from: 'email_send', backfill_migration: '20261012030000' })
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

describe('20261022120000 backfill: a running trial gets collections until the trial ends', () => {
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

  /** A company with nothing but the grants the test gives it (the trial trigger's rows removed). */
  async function bareCompany(client: PoolClient, userId: string, teamId: string | null = null): Promise<string> {
    const id = randomUUID()
    await client.query(
      `INSERT INTO public.companies (id, name, entity_type, created_by, team_id) VALUES ($1, 'Trial AB', 'aktiebolag', $2, $3)`,
      [id, userId, teamId],
    )
    await client.query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [id])
    return id
  }

  async function give(
    client: PoolClient,
    p: { companyId?: string | null; teamId?: string | null; key: string; source: string; expiresAt: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO public.capability_grants (company_id, team_id, capability_key, source, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.companyId ?? null, p.teamId ?? null, p.key, p.source, p.expiresAt],
    )
  }

  async function collectionsGrants(client: PoolClient, companyId: string) {
    const { rows } = await client.query<{ source: string; expires_at: Date | null; metadata: Record<string, unknown> | null }>(
      `SELECT source, expires_at, metadata FROM public.capability_grants
       WHERE capability_key = 'collections' AND company_id = $1 ORDER BY source`,
      [companyId],
    )
    return rows
  }

  it('mirrors each unexpired trial with its expiry, and gives nothing to a paid, a lapsed or a byrå company', async () => {
    const sql = readFileSync(TRIAL_MIGRATION_PATH, 'utf8')
    await inRolledBackTransaction(async (client) => {
      const userId = await insertAuthUser()
      const trialEnd = '2099-01-04T00:00:00.000Z'

      const trialCo = await bareCompany(client, userId)
      await give(client, { companyId: trialCo, key: 'bank_sync', source: 'trial', expiresAt: trialEnd })

      const paidCo = await bareCompany(client, userId)
      await give(client, { companyId: paidCo, key: 'bank_sync', source: 'trial', expiresAt: trialEnd })
      await give(client, { companyId: paidCo, key: 'collections', source: 'stripe', expiresAt: trialEnd })

      const lapsedCo = await bareCompany(client, userId)
      await give(client, { companyId: lapsedCo, key: 'bank_sync', source: 'trial', expiresAt: '2001-01-01T00:00:00.000Z' })

      // A byrå client: the trial trigger seeds nothing for it, so it holds no trial grant to mirror.
      const byraTeam = randomUUID()
      await client.query(`INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`, [
        byraTeam,
        userId,
      ])
      const byraCo = randomUUID()
      await client.query(
        `INSERT INTO public.companies (id, name, entity_type, created_by, team_id) VALUES ($1, 'Klient AB', 'aktiebolag', $2, $3)`,
        [byraCo, userId, byraTeam],
      )

      await client.query(sql)

      const trialRows = await collectionsGrants(client, trialCo)
      expect(trialRows).toHaveLength(1)
      expect(trialRows[0].source).toBe('trial')
      expect(trialRows[0].expires_at?.toISOString()).toBe(trialEnd)
      expect(trialRows[0].metadata).toEqual({ backfilled_from: 'bank_sync', backfill_migration: '20261022120000' })
      expect(await hasCapability(client, trialCo, 'collections')).toBe(true)

      expect((await collectionsGrants(client, paidCo)).map((r) => r.source)).toEqual(['stripe'])
      expect(await collectionsGrants(client, lapsedCo)).toEqual([])
      expect(await hasCapability(client, lapsedCo, 'collections')).toBe(false)
      expect(await collectionsGrants(client, byraCo)).toEqual([])

      // Re-running is a no-op.
      await client.query(sql)
      expect(await collectionsGrants(client, trialCo)).toHaveLength(1)
    })
  })
})
