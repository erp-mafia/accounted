/**
 * detectMomsredovisning: the TypeScript mirror of the exclusion predicate in
 * get_vat_declaration_totals / get_vat_ruta_source_lines (#2805).
 *
 * The SQL is what the web report runs and is covered against real Postgres in
 * tests/pg/vat-skattekonto-counter-entries.pg.test.ts. This file pins the
 * mirror to the SAME case table (a to f), and pins the three literals the SQL
 * carries to the constants exported here, so the two cannot drift silently.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  detectMomsredovisning,
  VAT_ACCOUNT_CLASS_PREFIX,
  VAT_SETTLEMENT_NET_ACCOUNTS,
  VAT_SHAPE_ROUNDING_ACCOUNTS,
  VAT_TAX_ACCOUNT_COUNTERPARTS,
} from '../vat-declaration'

describe('detectMomsredovisning', () => {
  it('(a) excludes a Skatteverket credit parked on a VAT account: 1630 D / 2610 K', () => {
    expect(detectMomsredovisning('manual', ['1630', '2610'])).toBe('tax_account_shape')
  })

  it('(a) excludes VAT settled or refunded straight against the skattekonto', () => {
    expect(detectMomsredovisning('manual', ['2611', '1630'])).toBe('tax_account_shape')
    expect(detectMomsredovisning('import', ['1630', '2641'])).toBe('tax_account_shape')
    // Several VAT accounts plus öresutjämning is still pure.
    expect(detectMomsredovisning('manual', ['2611', '2641', '1630', '3740'])).toBe(
      'tax_account_shape',
    )
  })

  it('(b) still excludes the reclassification through 1650: 2610 D / 1650 K', () => {
    expect(detectMomsredovisning('manual', ['2610', '1650'])).toBe('net_account_shape')
  })

  it('(d) keeps a bidrag received on the skattekonto: 1630 D / 3980 K', () => {
    // 3980 is a declaration account (ruta 42) but not a 26xx account, so the
    // second shape has nothing to hold on to.
    expect(detectMomsredovisning('manual', ['1630', '3980'])).toBeNull()
  })

  it('(e) keeps a business verifikat paid from the skattekonto: 5410 D / 2641 D / 1630 K', () => {
    expect(detectMomsredovisning('manual', ['5410', '2641', '1630'])).toBeNull()
  })

  it('(f) still excludes a classic settlement and one carrying a small cost line', () => {
    expect(detectMomsredovisning('manual', ['2611', '2641', '2650'])).toBe('net_account_shape')
    expect(detectMomsredovisning('import', ['2611', '2641', '2650', '6050', '3740'])).toBe(
      'net_account_shape',
    )
  })

  it('never reports the second shape when a 2650/1650 line is present', () => {
    // Shape 1 owns every entry with a net-account line, which keeps the two
    // shapes disjoint in the SQL (UNION without double listing).
    expect(detectMomsredovisning('manual', ['2611', '1630', '2650'])).toBe('net_account_shape')
  })

  it('does not treat a non-declaration 26xx account as the VAT side', () => {
    // 2670 (OSS) is 26xx but not on the momsdeklaration: no declaration
    // account, so nothing to exclude.
    expect(detectMomsredovisning('manual', ['2670', '1630'])).toBeNull()
    // It is tolerated NEXT TO a declaration account, though.
    expect(detectMomsredovisning('manual', ['2611', '2670', '1630'])).toBe('tax_account_shape')
  })

  it('leaves ordinary activity alone', () => {
    expect(detectMomsredovisning('invoice_created', ['1510', '3001', '2611'])).toBeNull()
    expect(detectMomsredovisning('manual', ['1630', '1930'])).toBeNull()
    // A plain payment of the VAT debt: no declaration account involved.
    expect(detectMomsredovisning('manual', ['2650', '1630'])).toBeNull()
    expect(detectMomsredovisning('manual', [])).toBeNull()
  })

  it('tags win, and opening balances are exempt from both shapes', () => {
    expect(detectMomsredovisning('vat_settlement', ['2611', '2650'])).toBe('tagged')
    expect(detectMomsredovisning('vat_settlement', ['1930', '3001'])).toBe('tagged')
    expect(detectMomsredovisning('opening_balance', ['2641', '2650'])).toBeNull()
    expect(detectMomsredovisning('opening_balance', ['2611', '1630'])).toBeNull()
  })

  it('covers the storno of an excluded entry, so annullera cannot re-inflate a ruta', () => {
    expect(detectMomsredovisning('storno', ['2610', '1630'])).toBe('tax_account_shape')
    expect(detectMomsredovisning('storno', ['2611', '2650'])).toBe('net_account_shape')
  })
})

describe('shape constants stay in step with the SQL', () => {
  // The RPCs carry their own literals (a new parameter would break the deployed
  // app between migration and deploy). Read them back from the NEWEST migration
  // that defines them, so a later redefinition is what gets compared.
  const migrationsDir = path.resolve(__dirname, '../../../../supabase/migrations')
  const newest = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .find((f) => readFileSync(path.join(migrationsDir, f), 'utf8').includes('tax_shape_constants AS ('))

  it('finds the migration that defines tax_shape_constants', () => {
    expect(newest).toBeDefined()
  })

  it('carries the same literals in BOTH functions', () => {
    const sql = readFileSync(path.join(migrationsDir, newest!), 'utf8')
    const blocks = [...sql.matchAll(/tax_shape_constants AS \(\s*SELECT([\s\S]*?)\n\s*\),/g)].map(
      (m) => m[1]!,
    )
    // One copy in get_vat_declaration_totals, one in get_vat_ruta_source_lines.
    expect(blocks).toHaveLength(2)

    const literal = (list: string[]) => `ARRAY[${list.map((a) => `'${a}'`).join(', ')}]::text[]`
    for (const block of blocks) {
      expect(block).toContain(`${literal(VAT_TAX_ACCOUNT_COUNTERPARTS)} AS tax_accounts`)
      expect(block).toContain(`${literal(VAT_SHAPE_ROUNDING_ACCOUNTS)} AS rounding_accounts`)
      expect(block).toContain(`'${VAT_ACCOUNT_CLASS_PREFIX}%'::text AS vat_account_pattern`)
    }
  })

  it('keeps the skattekonto out of the net-account list', () => {
    // If 1630 ever joined VAT_SETTLEMENT_NET_ACCOUNTS, shape 1 would swallow
    // 1630 D / 3980 K (case d) and every other skattekonto verifikat that
    // touches a beskattningsunderlag account.
    for (const account of VAT_TAX_ACCOUNT_COUNTERPARTS) {
      expect(VAT_SETTLEMENT_NET_ACCOUNTS).not.toContain(account)
    }
  })
})
