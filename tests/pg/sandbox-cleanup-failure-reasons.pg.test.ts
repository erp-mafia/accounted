import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The nightly sandbox cleanup reported "completed with failures" every night
 * with no reason anywhere but a Postgres WARNING (migration 20261109185036).
 *
 * Pinned here:
 *   - a sandbox holding the K3 asset registers added after the last teardown
 *     change (a replaced component: RESTRICT into its derecognition voucher,
 *     NO ACTION from the replacement; a write-down: RESTRICT into its voucher
 *     and its fiscal period) is torn down completely: those rows go with the
 *     assets delete, before the vouchers and the periods;
 *   - cleanup_expired_sandbox_users returns each failed user with the reason:
 *     SQLSTATE, message, the table and constraint for a foreign key refusal,
 *     and the context naming the teardown, so a refusal by design and a
 *     teardown gap can be told apart from the cron log.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }

const REPLACE_SQL = `SELECT * FROM public.commit_asset_component_replacement(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::numeric, $8::numeric, $9::jsonb
)`

const ADJUST_SQL = `SELECT * FROM public.commit_asset_value_adjustment(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::date, $7::numeric,
  $8::numeric, $9::text, $10::text, $11::text, $12::jsonb
)`

async function seedSandbox(): Promise<Seed> {
  const seed = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`,
    [seed.userId, seed.companyId],
  )
  return seed
}

/** A building split into two components, as asset-components.pg.test.ts seeds it. */
async function insertComponentBuilding(seed: Seed): Promise<{ assetId: string; stomme: string; tak: string }> {
  const assetId = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account
     ) VALUES ($1, $2, $3, 'Fastighet', 'building', '2026-01-01',
               1000000, 0, 600, 'linear', '1110', '1119', '7821')`,
    [assetId, seed.userId, seed.companyId],
  )
  const component = async (name: string, cost: number, life: number, sort: number) => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.asset_components (
         id, user_id, company_id, asset_id, name, cost, useful_life_months, acquisition_date, sort_order
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01', $8)`,
      [id, seed.userId, seed.companyId, assetId, name, cost, life, sort],
    )
    return id
  }
  const stomme = await component('Stomme', 800_000, 1200, 0)
  const tak = await component('Tak', 200_000, 300, 1)
  return { assetId, stomme, tak }
}

async function insertDraft(seed: Seed, entryDate: string, lines: Array<[string, number, number]>): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Sandboxtest', 'system', 'draft')`,
    [entryId, seed.userId, seed.companyId, seed.fiscalPeriodId, entryDate],
  )
  for (const [account, debit, credit] of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [entryId, account, debit, credit],
    )
  }
  return entryId
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(sql, params)
  return rows[0]!.n
}

async function authUserExists(id: string): Promise<boolean> {
  return (await count(`SELECT count(*)::int AS n FROM auth.users WHERE id = $1`, [id])) > 0
}

/** Every public table with a company_id column that still holds a row of `companyId`. */
async function leftoverTenantRows(companyId: string): Promise<Record<string, number>> {
  const { rows: tables } = await getPool().query<{ tbl: string }>(
    `SELECT format('%I.%I', c.table_schema, c.table_name) AS tbl
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
        AND t.table_type = 'BASE TABLE'`,
  )
  const left: Record<string, number> = {}
  for (const { tbl } of tables) {
    const n = await count(`SELECT count(*)::int AS n FROM ${tbl} WHERE company_id = $1`, [companyId])
    if (n > 0) left[tbl] = n
  }
  const company = await count(`SELECT count(*)::int AS n FROM public.companies WHERE id = $1`, [companyId])
  if (company > 0) left['public.companies'] = company
  return left
}

describe('sandbox teardown with K3 asset registers (pg)', () => {
  it('tears down a sandbox holding a replaced component and a component write-down', async () => {
    const seed = await seedSandbox()

    // A replaced roof: the derecognition voucher is RESTRICT from the old
    // component, and the new one points at the old with NO ACTION.
    const replaced = await insertComponentBuilding(seed)
    const replacementEntry = await insertDraft(seed, '2026-06-30', [
      ['7821', 4000, 0],
      ['1119', 0, 4000],
      ['1119', 4000, 0],
      ['1110', 0, 200_000],
      ['7972', 196_000, 0],
    ])
    await getPool().query(REPLACE_SQL, [
      seed.companyId, replaced.assetId, replaced.tak, replacementEntry, seed.fiscalPeriodId, '2026-06-30', 4000, 4000,
      JSON.stringify({ name: 'Nytt tak', cost: 250_000, useful_life_months: 360 }),
    ])

    // A nedskrivning on the balansdag, allocated over the components: each
    // row is RESTRICT into its voucher and its fiscal period.
    const impaired = await insertComponentBuilding(seed)
    const writeDownEntry = await insertDraft(seed, '2026-12-31', [
      ['7720', 100_000, 0],
      ['1118', 0, 100_000],
    ])
    await getPool().query(ADJUST_SQL, [
      seed.companyId, impaired.assetId, writeDownEntry, seed.fiscalPeriodId, 'impairment', '2026-12-31',
      100_000, 500_000, 'Marknadsvärdet har fallit betydligt (K3 27.4).', '7720', '1118',
      JSON.stringify([
        { component_id: impaired.stomme, amount: 80_000 },
        { component_id: impaired.tak, amount: 20_000 },
      ]),
    ])

    // The registers the teardown has to get past are really there.
    expect(
      await count(
        `SELECT count(*)::int AS n FROM public.asset_components
          WHERE company_id = $1 AND derecognition_journal_entry_id IS NOT NULL`,
        [seed.companyId],
      ),
    ).toBe(1)
    expect(
      await count(
        `SELECT count(*)::int AS n FROM public.asset_components
          WHERE company_id = $1 AND replaces_component_id IS NOT NULL`,
        [seed.companyId],
      ),
    ).toBe(1)
    expect(
      await count(`SELECT count(*)::int AS n FROM public.asset_value_adjustments WHERE company_id = $1`, [
        seed.companyId,
      ]),
    ).toBe(2)

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [seed.userId])

    expect(await authUserExists(seed.userId)).toBe(false)
    expect(await leftoverTenantRows(seed.companyId)).toEqual({})
  })
})

type Failure = {
  user_id: string
  kind: string
  sqlstate: string
  message: string
  table?: string
  constraint?: string
  context?: string
}

describe('cleanup_expired_sandbox_users reports why a teardown failed (pg)', () => {
  it('returns each failed user with its SQLSTATE, message, table, constraint and context', async () => {
    // Committed base rows; everything that makes them expired sandboxes is
    // written in the transaction below and rolled back, so no other test's
    // sweep ever finds them.
    const refused = await seedCompany()
    const blocked = await seedCompany()

    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Older than any other fixture, so a sweep of two attempts these two.
      await client.query(
        `INSERT INTO public.company_settings (user_id, company_id, is_sandbox, created_at)
         VALUES ($1, $2, true, '1980-01-01T00:00:00Z'), ($3, $4, true, '1980-01-02T00:00:00Z')`,
        [refused.userId, refused.companyId, blocked.userId, blocked.companyId],
      )
      // Refused by design: the visitor also created a company that is not a
      // sandbox, which the account delete would cascade into.
      await client.query(
        `INSERT INTO public.companies (id, name, entity_type, created_by)
         VALUES ($1, 'Annat Bolag AB', 'aktiebolag', $2)`,
        [randomUUID(), refused.userId],
      )
      // Refused on purpose (sandbox-teardown-coverage REFUSED_ON_PURPOSE): a
      // call made to Skatteverket, RESTRICT into companies and never deleted.
      await client.query(
        `INSERT INTO public.skatteverket_api_audit_log
           (company_id, user_id, endpoint, outcome, response_status)
         VALUES ($1, $2, 'agi/submit', 'ok', 200)`,
        [blocked.companyId, blocked.userId],
      )

      const { rows } = await client.query<{
        s: { cleaned: number; failed: number; attempted: number; next_offset: number; failures: Failure[] }
      }>(`SELECT public.cleanup_expired_sandbox_users(24, 2) AS s`)
      const summary = rows[0]!.s

      expect(summary).toMatchObject({ cleaned: 0, attempted: 2, next_offset: 2 })
      expect(summary.failures).toHaveLength(summary.failed)
      const byUser = new Map(summary.failures.map((f): [string, Failure] => [f.user_id, f]))

      const refusal = byUser.get(refused.userId)
      expect(refusal).toMatchObject({ kind: 'sandbox', sqlstate: 'P0001' })
      expect(refusal!.message).toMatch(/has data in a company that is not a sandbox/)
      expect(refusal!.context).toContain('cleanup_sandbox_user')
      // A RAISE names no table: the key is left out, not sent empty.
      expect(refusal).not.toHaveProperty('table')
      expect(refusal).not.toHaveProperty('constraint')

      const fk = byUser.get(blocked.userId)
      expect(fk).toMatchObject({
        kind: 'sandbox',
        sqlstate: '23503',
        table: 'public.skatteverket_api_audit_log',
        constraint: 'skatteverket_api_audit_log_company_id_fkey',
      })
      expect(fk!.message).toMatch(/violates foreign key constraint/)
      expect(fk!.context).toContain('cleanup_sandbox_user')

      // Both refusals rolled their teardown back.
      const { rows: users } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM auth.users WHERE id = ANY($1::uuid[])`,
        [[refused.userId, blocked.userId]],
      )
      expect(users[0]!.n).toBe(2)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('returns an empty failures list when nothing failed', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // Nothing is older than a thousand years: no candidate, no orphan.
      const { rows } = await client.query<{ s: { failed: number; failures: Failure[] } }>(
        `SELECT public.cleanup_expired_sandbox_users(24 * 365 * 1000, 10) AS s`,
      )
      expect(rows[0]!.s).toMatchObject({ failed: 0, failures: [] })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
