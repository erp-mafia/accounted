/**
 * The backfill in migration 20260903173000 maps country names with a SQL
 * function that carries its own copy of the name table. This test holds the
 * two copies to each other: every name the SQL knows must map to the same
 * code in TypeScript, and every name TypeScript knows must be in the SQL.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listKnownCountryNames, normalizeCountryCode } from '../country-codes'

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260903173000_customer_supplier_country_iso.sql',
)

function sqlNameTable(): Map<string, string> {
  const sql = readFileSync(MIGRATION, 'utf-8')
  const table = new Map<string, string>()
  const re = /^\s+\('((?:[^']|'')+)', '([A-Z]{2})'\),?$/gm
  for (const match of sql.matchAll(re)) {
    table.set(match[1].replace(/''/g, "'"), match[2])
  }
  return table
}

describe('normalize_country_code() SQL table vs normalizeCountryCode()', () => {
  it('maps every SQL name to the same code in TypeScript', () => {
    const sql = sqlNameTable()
    expect(sql.size).toBeGreaterThan(100)
    for (const [name, code] of sql) {
      expect(normalizeCountryCode(name), name).toBe(code)
    }
  })

  it('carries every TypeScript name in the SQL table', () => {
    const sql = sqlNameTable()
    const ts = listKnownCountryNames()
    const missing = ts.filter(([name, code]) => sql.get(name) !== code)
    expect(missing).toEqual([])
    expect(sql.size).toBe(ts.length)
  })
})
