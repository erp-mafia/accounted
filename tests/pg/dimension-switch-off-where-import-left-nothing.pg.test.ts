import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for
 * 20261124200100_dimension_switch_off_where_import_left_nothing.sql.
 *
 * An SIE import used to turn company_settings.dimensions_enabled on for any
 * file that declared a dimension. The migration turns it off again where that
 * left nothing to pick. Guards under test:
 *   - a company the import switched on, with no value, is switched off
 *   - a company a person switched on is left alone, with or without an older
 *     import
 *   - the last switch decides, not an earlier one, in both orders
 *   - the edges of "the import's doing": before the import existed, 90
 *     seconds after it was created, three minutes after
 *   - a company whose settings were created with the switch on is left alone
 *   - a company with a dimension value, a per-account rule, a dimension of
 *     its own or a tagged line (on any dimension) is left alone; a dimension
 *     the import registered is not its own
 *   - a company archived by a migration reset is skipped, and the run does
 *     not fail on it
 *   - one audit row per company, tagged as the system and this migration
 *   - idempotent (a re-run changes nothing and writes no audit row)
 */

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261124200100_dimension_switch_off_where_import_left_nothing.sql',
  ),
  'utf8',
)

const LABEL = 'migration 20261124200100 dimension_switch_off_where_import_left_nothing'

type Seed = Awaited<ReturnType<typeof seedCompany>>

async function runMigration(): Promise<void> {
  await getPool().query(MIGRATION_SQL)
}

async function insertSettings(seed: Seed, dimensionsEnabled: boolean): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, user_id, dimensions_enabled)
     VALUES ($1, $2, $3)`,
    [seed.companyId, seed.userId, dimensionsEnabled],
  )
}

/** An SIE import of the company, created `ago` before now. Returns its id. */
async function insertImport(seed: Seed, ago = '0 seconds'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.sie_imports (company_id, user_id, filename, file_hash, sie_type, status, created_at)
     VALUES ($1, $2, 'pg-dimension-switch.se', md5(gen_random_uuid()::text), 4, 'completed',
             now() - $3::interval)
     RETURNING id`,
    [seed.companyId, seed.userId, ago],
  )
  return rows[0].id
}

/** The switch goes from off to on now, as the import or the settings page does it. */
async function switchOn(seed: Seed): Promise<void> {
  await getPool().query(
    `UPDATE public.company_settings SET dimensions_enabled = true WHERE company_id = $1`,
    [seed.companyId],
  )
}

/**
 * The audit row of a switch made `ago` before now, written the way
 * audit_company_settings writes it. For histories that span hours: the
 * settings row of such a company is created with the switch on, so these
 * rows are its whole switch history.
 */
async function recordSwitch(seed: Seed, to: 'on' | 'off', ago: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.audit_log
       (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, created_at)
     VALUES ($1, $2, 'UPDATE', 'company_settings', $3, $1, $4::jsonb, $5::jsonb, now() - $6::interval)`,
    [
      seed.userId,
      seed.companyId,
      randomUUID(),
      JSON.stringify({ company_id: seed.companyId, dimensions_enabled: to === 'off' }),
      JSON.stringify({ company_id: seed.companyId, dimensions_enabled: to === 'on' }),
      ago,
    ],
  )
}

async function isOn(seed: Seed): Promise<boolean> {
  const { rows } = await getPool().query<{ dimensions_enabled: boolean }>(
    `SELECT dimensions_enabled FROM public.company_settings WHERE company_id = $1`,
    [seed.companyId],
  )
  return rows[0].dimensions_enabled
}

/** A company an import switched on: settings off, an import, the switch on moments later. */
async function seedSwitchedOnByImport(): Promise<Seed & { importId: string }> {
  const seed = await seedCompany()
  await insertSettings(seed, false)
  const importId = await insertImport(seed)
  await switchOn(seed)
  return { ...seed, importId }
}

/**
 * A company with the switch on and a written history: one import created an
 * hour ago and one switch to on, `switchedAgo` before now.
 */
async function seedSwitchedOnAt(switchedAgo: string): Promise<Seed> {
  const seed = await seedCompany()
  await insertSettings(seed, true)
  await insertImport(seed, '1 hour')
  await recordSwitch(seed, 'on', switchedAgo)
  return seed
}

async function dimensionId(seed: Seed, sieDimNo: 1 | 6): Promise<string> {
  const pool = getPool()
  await pool.query(`SELECT public.ensure_company_dimensions($1)`, [seed.companyId])
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = $2`,
    [seed.companyId, sieDimNo],
  )
  return rows[0].id
}

describe('dimension_switch_off_where_import_left_nothing', () => {
  it('switches off a company the import switched on with nothing to pick', async () => {
    const seed = await seedSwitchedOnByImport()
    expect(await isOn(seed)).toBe(true)

    await runMigration()

    expect(await isOn(seed)).toBe(false)
  })

  it('keeps the registered dimensions', async () => {
    const seed = await seedSwitchedOnByImport()
    await dimensionId(seed, 6)

    await runMigration()

    expect(await isOn(seed)).toBe(false)
    const { rows } = await getPool().query<{ sie_dim_no: number }>(
      `SELECT sie_dim_no FROM public.dimensions WHERE company_id = $1 ORDER BY sie_dim_no`,
      [seed.companyId],
    )
    expect(rows.map((r) => r.sie_dim_no)).toEqual([1, 6])
  })

  it('leaves a company alone when a person switched it on and it never imported', async () => {
    const seed = await seedCompany()
    await insertSettings(seed, false)
    await switchOn(seed)

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('leaves a company alone when the switch went on hours after its import', async () => {
    const seed = await seedCompany()
    await insertSettings(seed, false)
    await insertImport(seed, '3 hours')
    await switchOn(seed)

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('leaves a company alone when its settings were created with the switch on', async () => {
    const seed = await seedCompany()
    await insertSettings(seed, true)
    await insertImport(seed)

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('goes by the last switch: the import first, a person later, is left alone', async () => {
    const seed = await seedCompany()
    await insertSettings(seed, true)
    await insertImport(seed, '3 hours')
    await recordSwitch(seed, 'on', '2 hours 59 minutes 55 seconds')
    await recordSwitch(seed, 'off', '2 hours')
    await recordSwitch(seed, 'on', '1 hour')

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('goes by the last switch: a person first, the import later, is switched off', async () => {
    const seed = await seedCompany()
    await insertSettings(seed, true)
    await recordSwitch(seed, 'on', '5 hours')
    await recordSwitch(seed, 'off', '4 hours')
    await insertImport(seed, '3 hours')
    await recordSwitch(seed, 'on', '2 hours 59 minutes 55 seconds')

    await runMigration()

    expect(await isOn(seed)).toBe(false)
  })

  it("counts a switch as the import's from the import's creation to two minutes after", async () => {
    // The import was created an hour ago in each of these.
    const before = await seedSwitchedOnAt('1 hour 30 seconds')
    const ninetySecondsAfter = await seedSwitchedOnAt('58 minutes 30 seconds')
    const threeMinutesAfter = await seedSwitchedOnAt('57 minutes')

    await runMigration()

    expect(await isOn(before)).toBe(true)
    expect(await isOn(ninetySecondsAfter)).toBe(false)
    expect(await isOn(threeMinutesAfter)).toBe(true)
  })

  it('leaves a company with a dimension value alone', async () => {
    const seed = await seedSwitchedOnByImport()
    await getPool().query(
      `INSERT INTO public.dimension_values (company_id, dimension_id, code, name)
       VALUES ($1, $2, 'P1', 'Projekt ett')`,
      [seed.companyId, await dimensionId(seed, 6)],
    )

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('leaves a company with only an archived dimension value alone', async () => {
    const seed = await seedSwitchedOnByImport()
    await getPool().query(
      `INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
       VALUES ($1, $2, 'P1', 'Avslutat projekt', false)`,
      [seed.companyId, await dimensionId(seed, 6)],
    )

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('leaves a company with a per-account dimension rule alone', async () => {
    const seed = await seedSwitchedOnByImport()
    await getPool().query(
      `INSERT INTO public.account_dimension_rules (company_id, account_number, dimension_id, rule_type)
       VALUES ($1, '5010', $2, 'required')`,
      [seed.companyId, await dimensionId(seed, 6)],
    )

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('leaves a company alone when it created a dimension of its own', async () => {
    const seed = await seedSwitchedOnByImport()
    await getPool().query(
      `INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
       VALUES ($1, 20, 'Region', false, false, 30)`,
      [seed.companyId],
    )

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('leaves a company alone when it archived a dimension', async () => {
    const seed = await seedSwitchedOnByImport()
    const id = await dimensionId(seed, 1)
    await getPool().query(`UPDATE public.dimensions SET is_active = false WHERE id = $1`, [id])

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it("does not count a dimension the import registered as the company's own", async () => {
    const seed = await seedSwitchedOnByImport()
    await getPool().query(
      `INSERT INTO public.dimensions
         (company_id, sie_dim_no, name, resets_annually, is_system, sort_order, created_by_import_id)
       VALUES ($1, 20, 'Avdelning', true, false, 30, $2)`,
      [seed.companyId, seed.importId],
    )

    await runMigration()

    expect(await isOn(seed)).toBe(false)
  })

  it.each(['1', '6', '20'])('leaves a company with a line tagged on dimension %s alone', async (dim) => {
    const seed = await seedSwitchedOnByImport()
    await insertPostedJournalEntry({
      userId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      lines: [
        { accountNumber: '1930', debitAmount: 100, creditAmount: 0, dimensions: { [dim]: 'X1' } },
        { accountNumber: '3001', debitAmount: 0, creditAmount: 100 },
      ],
    })

    await runMigration()

    expect(await isOn(seed)).toBe(true)
  })

  it('skips a company archived by a migration reset, and the run goes through', async () => {
    const source = await seedSwitchedOnByImport()
    const replacement = await seedCompany()
    // From here the source's rows refuse every write.
    await getPool().query(
      `INSERT INTO public.company_migration_resets
         (source_company_id, replacement_company_id, reason, confirmation_snapshot, source_counts)
       VALUES ($1, $2, 'dimension switch test: a reset source stays as it is', '{}'::jsonb, '{}'::jsonb)`,
      [source.companyId, replacement.companyId],
    )
    const other = await seedSwitchedOnByImport()

    await runMigration()

    expect(await isOn(source)).toBe(true)
    expect(await isOn(other)).toBe(false)
  })

  it('audits the change as the system, not a person, and is a no-op on re-run', async () => {
    const seed = await seedSwitchedOnByImport()
    const pool = getPool()
    const offAudits = async () =>
      (
        await pool.query<{ actor_type: string; actor_label: string | null }>(
          `SELECT actor_type, actor_label
             FROM public.audit_log
            WHERE table_name = 'company_settings' AND company_id = $1 AND action = 'UPDATE'
              AND old_state->>'dimensions_enabled' = 'true'
              AND new_state->>'dimensions_enabled' = 'false'`,
          [seed.companyId],
        )
      ).rows
    const updatedAt = async () =>
      (
        await pool.query<{ updated_at: Date }>(
          `SELECT updated_at FROM public.company_settings WHERE company_id = $1`,
          [seed.companyId],
        )
      ).rows[0].updated_at.toISOString()

    expect(await offAudits()).toHaveLength(0)
    await runMigration()
    expect(await isOn(seed)).toBe(false)
    const audits = await offAudits()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actor_type: 'system', actor_label: LABEL })

    const firstUpdatedAt = await updatedAt()
    await runMigration()
    expect(await isOn(seed)).toBe(false)
    expect(await updatedAt()).toBe(firstUpdatedAt)
    expect(await offAudits()).toHaveLength(1)
  })
})
