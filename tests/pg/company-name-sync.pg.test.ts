import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from './fixtures'

/**
 * pg-real coverage for 20261015201209_sync_company_name_from_settings.sql
 * (crm#1209).
 *
 * The company's name lives on company_settings.company_name (what
 * Inställningar edits) and on companies.name (what the inbox address, payslips,
 * AGI and payment files read). Before this migration a rename only reached
 * the first copy. Pinned here:
 *   - a rename through the settings row, as the owner under RLS, renames the
 *     company too and leaves the active inbox address as it is
 *   - a blank or NULL settings name never overwrites companies.name
 *   - inserting a settings row (company creation, the migration reset's copy)
 *     brings companies.name along
 *   - a save that carries an unchanged name writes nothing to companies when
 *     they agree, and heals a row that had drifted
 *   - "Skapa ny inkorgsadress" (rotate_company_inbox) slugs the current name
 *   - the backfill syncs a drifted company, leaves archived companies, blank
 *     names, migration reset sources and inbox addresses alone, and is
 *     idempotent
 */

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20261015201209_sync_company_name_from_settings.sql',
)

// Run the statement that ships, not a copy of it.
function backfillStatement(): string {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
  const start = sql.indexOf('-- backfill:begin')
  const end = sql.indexOf('-- backfill:end')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return sql.slice(start + '-- backfill:begin'.length, end)
}

async function insertSettings(
  userId: string,
  companyId: string,
  companyName: string | null,
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings
       (user_id, company_id, entity_type, company_name, org_number,
        onboarding_complete, onboarding_step)
     VALUES ($1, $2, 'aktiebolag', $3, '5590000001', true, 4)`,
    [userId, companyId, companyName],
  )
}

/** Simulate the pre-migration state: companies.name left behind. */
async function driftCompanyName(companyId: string, staleName: string): Promise<void> {
  await getPool().query(`UPDATE public.companies SET name = $2 WHERE id = $1`, [
    companyId,
    staleName,
  ])
}

async function companyRow(
  client: PoolClient | ReturnType<typeof getPool>,
  companyId: string,
): Promise<{ name: string; xmin: string }> {
  const { rows } = await client.query<{ name: string; xmin: string }>(
    `SELECT name, xmin::text AS xmin FROM public.companies WHERE id = $1`,
    [companyId],
  )
  return rows[0]!
}

async function inboxAddresses(
  client: PoolClient | ReturnType<typeof getPool>,
  companyId: string,
): Promise<Array<{ local_part: string; status: string }>> {
  const { rows } = await client.query<{ local_part: string; status: string }>(
    `SELECT local_part, status FROM public.company_inboxes
     WHERE company_id = $1 ORDER BY created_at, local_part`,
    [companyId],
  )
  return rows
}

describe('company name sync from company_settings (pg)', () => {
  it('a rename by the owner renames the company and keeps the inbox address', async () => {
    const { userId, companyId } = await seedCompany()
    await insertSettings(userId, companyId, 'Test AB')
    const inboxBefore = await inboxAddresses(getPool(), companyId)
    expect(inboxBefore).toHaveLength(1)
    expect(inboxBefore[0]!.local_part).toMatch(/^test-ab-[a-z0-9]{4}$/)

    await withUserContext(userId, async (client) => {
      const updated = await client.query(
        `UPDATE public.company_settings SET company_name = 'Nytt Namn AB'
         WHERE company_id = $1 RETURNING company_id`,
        [companyId],
      )
      expect(updated.rowCount).toBe(1)

      expect((await companyRow(client, companyId)).name).toBe('Nytt Namn AB')
      expect(await inboxAddresses(client, companyId)).toEqual(inboxBefore)
    })
  })

  it('never overwrites companies.name with a blank or NULL settings name', async () => {
    const { userId, companyId } = await seedCompany()
    await insertSettings(userId, companyId, null)
    expect((await companyRow(getPool(), companyId)).name).toBe('Test AB')

    await withUserContext(userId, async (client) => {
      await client.query(
        `UPDATE public.company_settings SET company_name = '   ' WHERE company_id = $1`,
        [companyId],
      )
      expect((await companyRow(client, companyId)).name).toBe('Test AB')

      await client.query(
        `UPDATE public.company_settings SET company_name = NULL WHERE company_id = $1`,
        [companyId],
      )
      expect((await companyRow(client, companyId)).name).toBe('Test AB')
    })
  })

  it('brings companies.name along when the settings row is inserted', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, name: 'Mitt företag' })
    await insertCompanyMember({ companyId, userId, role: 'owner' })

    await insertSettings(userId, companyId, 'Registrerat Namn AB')

    expect((await companyRow(getPool(), companyId)).name).toBe('Registrerat Namn AB')
  })

  it('writes nothing to companies when an unchanged name is saved, and heals a drifted row', async () => {
    const { userId, companyId } = await seedCompany()
    await insertSettings(userId, companyId, 'Samma Namn AB')
    const before = await companyRow(getPool(), companyId)
    expect(before.name).toBe('Samma Namn AB')

    await withUserContext(userId, async (client) => {
      // The settings form sends every field on every save.
      await client.query(
        `UPDATE public.company_settings SET company_name = 'Samma Namn AB', city = 'Uppsala'
         WHERE company_id = $1`,
        [companyId],
      )
      // No new row version: the companies row was neither written nor locked.
      expect(await companyRow(client, companyId)).toEqual(before)
    })

    await driftCompanyName(companyId, 'Gammalt Namn AB')
    await withUserContext(userId, async (client) => {
      await client.query(
        `UPDATE public.company_settings SET company_name = 'Samma Namn AB' WHERE company_id = $1`,
        [companyId],
      )
      expect((await companyRow(client, companyId)).name).toBe('Samma Namn AB')
    })
  })

  it('a new inbox address after a rename carries the current name', async () => {
    const { userId, companyId } = await seedCompany()
    await insertSettings(userId, companyId, 'Test AB')

    await withUserContext(userId, async (client) => {
      await client.query(
        `UPDATE public.company_settings SET company_name = 'Forthright Öst AB' WHERE company_id = $1`,
        [companyId],
      )
      const { rows } = await client.query<{ local_part: string; status: string }>(
        `SELECT local_part, status FROM public.rotate_company_inbox($1)`,
        [companyId],
      )
      expect(rows[0]!.status).toBe('active')
      expect(rows[0]!.local_part).toMatch(/^forthright-ost-ab-[a-z0-9]{4}$/)
    })
  })

  it('backfill: syncs a drifted company and leaves inbox addresses alone, idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    await insertSettings(userId, companyId, 'Omdöpt AB')
    await driftCompanyName(companyId, 'Testbolaget AB')
    const inboxBefore = await inboxAddresses(getPool(), companyId)

    await withUserContext(userId, async (client) => {
      await client.query('RESET ROLE')
      const first = await client.query(backfillStatement())
      expect(first.rowCount).toBeGreaterThanOrEqual(1)

      expect((await companyRow(client, companyId)).name).toBe('Omdöpt AB')
      expect(await inboxAddresses(client, companyId)).toEqual(inboxBefore)

      const second = await client.query(backfillStatement())
      expect(second.rowCount).toBe(0)
    })
  })

  it('backfill: leaves archived companies and blank settings names alone', async () => {
    const archived = await seedCompany()
    await insertSettings(archived.userId, archived.companyId, 'Arkiverat Nytt AB')
    await driftCompanyName(archived.companyId, 'Arkiverat Gammalt AB')
    await getPool().query(
      `UPDATE public.companies SET archived_at = now(), archived_by = $2 WHERE id = $1`,
      [archived.companyId, archived.userId],
    )

    const blank = await seedCompany()
    await insertSettings(blank.userId, blank.companyId, '')

    await withUserContext(archived.userId, async (client) => {
      await client.query('RESET ROLE')
      await client.query(backfillStatement())

      expect((await companyRow(client, archived.companyId)).name).toBe('Arkiverat Gammalt AB')
      expect((await companyRow(client, blank.companyId)).name).toBe('Test AB')
    })
  })

  it('backfill: never touches a migration reset source; the replacement takes the settings name', async () => {
    const { userId, companyId } = await seedCompany()
    await insertSettings(userId, companyId, 'Reset AB')
    await driftCompanyName(companyId, 'Före Omstart AB')

    await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{
        result: { ok: boolean; replacement_company_id?: string }
      }>(`SELECT public.reset_company_for_migration($1, 'Reset AB', $2, true, true) AS result`, [
        companyId,
        'The first migration used the wrong fiscal periods.',
      ])
      expect(rows[0]!.result).toMatchObject({ ok: true })
      const replacementId = rows[0]!.result.replacement_company_id!
      await client.query('RESET ROLE')

      // The replacement row is created from the stale companies.name; its
      // settings copy brings the current name along.
      expect((await companyRow(client, replacementId)).name).toBe('Reset AB')

      // Must not raise: a write to the source would trip
      // zz_companies_block_migration_reset_source_mutation on deploy.
      await client.query(backfillStatement())

      expect((await companyRow(client, companyId)).name).toBe('Före Omstart AB')
    })
  })
})
