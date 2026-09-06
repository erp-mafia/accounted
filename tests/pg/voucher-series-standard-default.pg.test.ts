import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'
import { STANDARD_VOUCHER_SERIES_MAP } from '@/lib/bookkeeping/voucher-series-resolver'

/**
 * `company_settings.default_voucher_series_per_source_type` column default
 * (migration 20260906210500, issue #2184).
 *
 * Three invariants, all against the real column:
 *   1. a fresh row gets the standard set, equal to the TS constant the
 *      settings action writes, so a new company and "Använd
 *      standarduppsättningen" mean the same thing;
 *   2. the default names every source type journal_entries accepts, so a new
 *      source type cannot slip back onto 'A' through the resolver's fallback
 *      the way seven of them had before this migration;
 *   3. re-running the migration leaves an existing all-A row alone: the
 *      standard set reaches an existing company only when it asks for it.
 * Superuser pool on purpose: the object under test is the default, not RLS.
 */

const MIGRATION_PATH = join(
  process.cwd(),
  'supabase/migrations/20260906210500_voucher_series_standard_default.sql',
)

type SeriesMap = Record<string, string>

const LEGACY_ALL_A: SeriesMap = Object.fromEntries(
  Object.keys(STANDARD_VOUCHER_SERIES_MAP).map((sourceType) => [sourceType, 'A']),
)

async function insertSettings(): Promise<string> {
  const { companyId } = await seedCompany()
  // A trigger may already have created the row; either way one exists after this.
  await getPool().query(
    `INSERT INTO public.company_settings (company_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [companyId],
  )
  return companyId
}

async function readMap(companyId: string): Promise<SeriesMap> {
  const { rows } = await getPool().query<{ map: SeriesMap }>(
    `SELECT default_voucher_series_per_source_type AS map
       FROM public.company_settings
      WHERE company_id = $1`,
    [companyId],
  )
  return rows[0].map
}

describe('company_settings.default_voucher_series_per_source_type default', () => {
  it('gives a fresh row the standard set, equal to STANDARD_VOUCHER_SERIES_MAP', async () => {
    const companyId = await insertSettings()
    expect(await readMap(companyId)).toEqual(STANDARD_VOUCHER_SERIES_MAP)
  })

  it('names every source type the journal_entries CHECK accepts', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'public.journal_entries'::regclass
          AND conname = 'journal_entries_source_type_check'`,
    )
    expect(rows).toHaveLength(1)
    const accepted = Array.from(rows[0].def.matchAll(/'([a-z_]+)'/g), (m) => m[1]).sort()
    expect(accepted.length).toBeGreaterThan(0)

    const companyId = await insertSettings()
    expect(Object.keys(await readMap(companyId)).sort()).toEqual(accepted)
  })

  it('re-applying the migration leaves an existing all-A row untouched', async () => {
    const existing = await insertSettings()
    await getPool().query(
      `UPDATE public.company_settings
          SET default_voucher_series_per_source_type = $2::jsonb
        WHERE company_id = $1`,
      [existing, JSON.stringify(LEGACY_ALL_A)],
    )

    await getPool().query(readFileSync(MIGRATION_PATH, 'utf8'))

    expect(await readMap(existing)).toEqual(LEGACY_ALL_A)
    // ...while a row created afterwards still starts on the standard set.
    const fresh = await insertSettings()
    expect(await readMap(fresh)).toEqual(STANDARD_VOUCHER_SERIES_MAP)
  })
})
