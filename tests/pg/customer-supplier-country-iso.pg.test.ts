/**
 * pg-real test for migration 20260903173000: customers.country and
 * suppliers.country are ISO 3166-1 alpha-2 (#2025, #2028).
 *
 * The backfill ran once when the migration was applied. Its SQL helper
 * normalize_country_code was dropped in 20261012100300 (no caller left), so
 * what is pinned here is the rollback column it left behind and that the
 * column default is still the code, not a name.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'

describe('country columns after migration 20260903173000', () => {
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
