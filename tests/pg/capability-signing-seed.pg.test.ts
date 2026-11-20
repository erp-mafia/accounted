import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { PAID_CAPABILITIES, PAID_PLAN_ONLY_CAPABILITIES, TRIAL_CAPABILITIES } from '@/lib/entitlements/keys'

// BankID document signing joined the paid plan and the trial as the
// capability 'signing' at 20261028130000: the company-creation trial seeds
// it, and the migration's backfill mirrors every active email_send grant
// (trial, stripe, manual incl. byrå team agreements, comp) with its source,
// scope and expiry.

const MIGRATION_PATH = path.resolve(__dirname, '../../supabase/migrations/20261028130000_signing_capability.sql')

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

describe('signing capability: part of the paid plan and the trial', () => {
  it('is paid, and in the trial', () => {
    expect(PAID_CAPABILITIES).toContain('signing')
    expect(PAID_PLAN_ONLY_CAPABILITIES).not.toContain('signing')
    expect(TRIAL_CAPABILITIES).toContain('signing')
  })

  it('a new company gets the trial keys, signing among them', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    expect(await grantKeys(companyId, 'trial')).toEqual([...TRIAL_CAPABILITIES].sort())
    expect(await hasCapability(null, companyId, 'signing')).toBe(true)
  })

  it('a company created under a byrå team gets no signing trial either', async () => {
    const owner = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(`INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`, [teamId, owner])
    const companyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.companies (id, name, entity_type, created_by, team_id)
       VALUES ($1, 'Klient AB', 'aktiebolag', $2, $3)`,
      [companyId, owner, teamId],
    )
    expect(await grantKeys(companyId)).toEqual([])
  })
})

describe('20261028130000 backfill: mirrors every active email_send grant', () => {
  async function bareCompany(client: PoolClient, userId: string, teamId: string | null = null): Promise<string> {
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

  async function signingRows(client: PoolClient, where: { companyId?: string; teamId?: string }) {
    const { rows } = await client.query<{
      source: string
      expires_at: Date | null
      company_id: string | null
      team_id: string | null
      metadata: Record<string, unknown>
    }>(
      `SELECT source, expires_at, company_id, team_id, metadata FROM public.capability_grants
       WHERE capability_key = 'signing'
         AND (($1::uuid IS NOT NULL AND company_id = $1) OR ($2::uuid IS NOT NULL AND team_id = $2))
       ORDER BY source`,
      [where.companyId ?? null, where.teamId ?? null],
    )
    return rows
  }

  it('copies trial, stripe, comp and team-scoped manual rows with their expiry; skips expired and connector rows', async () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8')
    await inRolledBackTransaction(async (client) => {
      const userId = await insertAuthUser()
      const periodEnd = '2099-01-04T00:00:00.000Z'

      const trialCo = await bareCompany(client, userId)
      await grant(client, { companyId: trialCo, source: 'trial', expiresAt: periodEnd })

      const stripeCo = await bareCompany(client, userId)
      await grant(client, { companyId: stripeCo, source: 'stripe', expiresAt: periodEnd })

      const compCo = await bareCompany(client, userId)
      await grant(client, { companyId: compCo, source: 'comp', expiresAt: null })

      const lapsedCo = await bareCompany(client, userId)
      await grant(client, { companyId: lapsedCo, source: 'trial', expiresAt: '2001-01-01T00:00:00.000Z' })

      const connectorCo = await bareCompany(client, userId)
      await grant(client, { companyId: connectorCo, source: 'connector', expiresAt: periodEnd })

      const teamId = randomUUID()
      await client.query(`INSERT INTO public.teams (id, name, created_by, kind) VALUES ($1, 'Byrå', $2, 'byra')`, [teamId, userId])
      await grant(client, { teamId, source: 'manual', expiresAt: null })
      const teamClient = await bareCompany(client, userId, teamId)

      await client.query(sql)

      const trialRows = await signingRows(client, { companyId: trialCo })
      expect(trialRows.map((r) => [r.source, r.expires_at?.toISOString()])).toEqual([['trial', periodEnd]])
      expect(trialRows[0].metadata).toEqual({ backfilled_from: 'email_send', backfill_migration: '20261028130000' })
      expect(await hasCapability(client, trialCo, 'signing')).toBe(true)

      const stripeRows = await signingRows(client, { companyId: stripeCo })
      expect(stripeRows.map((r) => [r.source, r.expires_at?.toISOString()])).toEqual([['stripe', periodEnd]])

      const compRows = await signingRows(client, { companyId: compCo })
      expect(compRows.map((r) => [r.source, r.expires_at])).toEqual([['comp', null]])

      const teamRows = await signingRows(client, { teamId })
      expect(teamRows.map((r) => [r.source, r.company_id, r.team_id])).toEqual([['manual', null, teamId]])
      // The team grant cascades to the byrå's client company.
      expect(await hasCapability(client, teamClient, 'signing')).toBe(true)

      expect(await signingRows(client, { companyId: lapsedCo })).toEqual([])
      expect(await hasCapability(client, lapsedCo, 'signing')).toBe(false)
      expect(await signingRows(client, { companyId: connectorCo })).toEqual([])

      // Re-running is a no-op (ON CONFLICT DO NOTHING on the grant key).
      await client.query(sql)
      expect(await signingRows(client, { companyId: stripeCo })).toHaveLength(1)
    })
  })
})
