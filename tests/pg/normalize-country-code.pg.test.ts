/**
 * pg-real test for migration 20260903170000: customers.country and
 * suppliers.country are ISO 3166-1 alpha-2 (#2025, #2028).
 *
 * The backfill ran once when the migration was applied, so what can be
 * pinned here is the function it used (the SQL twin of normalizeCountryCode
 * in lib/vat/country-codes.ts), the rollback column it left behind, and that
 * the column default is still the code, not a name.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'

async function normalize(input: string | null): Promise<string | null> {
  const { rows } = await getPool().query<{ code: string | null }>(
    'select public.normalize_country_code($1) as code',
    [input],
  )
  return rows[0].code
}

describe('normalize_country_code()', () => {
  it('passes codes through uppercased and maps EL/UK', async () => {
    expect(await normalize('SE')).toBe('SE')
    expect(await normalize('de')).toBe('DE')
    expect(await normalize(' no ')).toBe('NO')
    expect(await normalize('EL')).toBe('GR')
    expect(await normalize('UK')).toBe('GB')
  })

  it('maps the Swedish and English names the form and the v1 API wrote', async () => {
    expect(await normalize('Sweden')).toBe('SE')
    expect(await normalize('Sverige')).toBe('SE')
    expect(await normalize('GERMANY')).toBe('DE')
    expect(await normalize('Tyskland')).toBe('DE')
    expect(await normalize('Deutschland')).toBe('DE')
    expect(await normalize('  Nederländerna ')).toBe('NL')
    expect(await normalize('United States of America')).toBe('US')
    expect(await normalize('U.S.A.')).toBe('US')
    expect(await normalize('Grekland')).toBe('GR')
  })

  it('returns null for empty input and names it does not know', async () => {
    expect(await normalize(null)).toBeNull()
    expect(await normalize('')).toBeNull()
    expect(await normalize('   ')).toBeNull()
    expect(await normalize('Atlantis')).toBeNull()
    expect(await normalize('S')).toBeNull()
    expect(await normalize('SWE')).toBeNull()
  })
})

describe('country columns after migration 20260903170000', () => {
  it('keeps the pre-backfill text in country_raw on both tables', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('customers', 'suppliers')
          and column_name = 'country_raw'
        order by table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(['customers', 'suppliers'])
  })

  it('defaults country to the code SE on both tables', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_default: string | null }>(
      `select table_name, column_default
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('customers', 'suppliers')
          and column_name = 'country'
        order by table_name`,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.column_default).toContain("'SE'")
    }
  })
})
