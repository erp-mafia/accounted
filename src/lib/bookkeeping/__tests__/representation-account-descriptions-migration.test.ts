import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getBASReference } from '../bas-reference'

/**
 * The shape of 20261023011000_representation_account_descriptions.sql
 * (accounted#92): the texts it writes are today's BAS reference texts, it
 * only replaces a description that is still the exact old seed text, it skips
 * the companies a migration reset archived, and it touches nothing but the
 * description. The pg-real run is tests/pg/representation-account-descriptions.pg.test.ts.
 */
const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261023011000_representation_account_descriptions.sql'),
  'utf8',
)

/** The (account_number, old_text, new_text) rows of the migration's VALUES list. */
function seedRows(): Array<{ account: string; oldText: string; newText: string }> {
  const rows = [...SQL.matchAll(/\('(\d{4})',\s*'([^']*)',\s*'([^']*)'\)/g)]
  return rows.map(([, account, oldText, newText]) => ({ account, oldText, newText }))
}

describe('migration 20261023011000 representation_account_descriptions', () => {
  it('writes exactly the BAS reference description of each account', () => {
    const rows = seedRows()
    expect(rows.map((r) => r.account)).toEqual(['6072', '7631', '7632'])
    for (const row of rows) {
      expect(row.newText, row.account).toBe(getBASReference(row.account)?.description)
      expect(row.oldText, row.account).not.toBe(row.newText)
    }
  })

  it('replaces only the untouched old seed text, outside migration-reset companies', () => {
    expect(SQL).toMatch(/where coa\.account_number = seed\.account_number\s+and coa\.description = seed\.old_text/)
    expect(SQL).toMatch(/not exists \(\s*select 1\s+from public\.company_migration_resets r\s+where r\.source_company_id = coa\.company_id/)
  })

  it('sets the description and nothing else, audited as the system', () => {
    const sets = [...SQL.matchAll(/\bset\s+(\w+)\s*=/gi)].map((m) => m[1])
    expect(sets).toEqual(['description'])
    expect(SQL).not.toMatch(/account_name\s*=/)
    expect(SQL).toContain("set_config('gnubok.actor_type', 'system', true)")
    expect(SQL).toContain("'migration 20261023011000 representation_account_descriptions'")
  })

  // The old 7631 text called a jullunch deductible; the new one sends meals to 7632.
  it('no longer calls a jullunch deductible', () => {
    const r7631 = seedRows().find((r) => r.account === '7631')!
    expect(r7631.oldText).toContain('jullunch')
    expect(r7631.newText).toContain('bokas på 7632')
  })
})
