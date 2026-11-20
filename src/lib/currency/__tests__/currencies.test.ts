import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENCIES, FOREIGN_CURRENCIES } from '@/types'
import { CurrencySchema } from '@/lib/api/schemas'
import { RIKSBANKEN_CURRENCIES } from '@/lib/currency/riksbanken'

/**
 * The currency set lives in two places that cannot share code: the TS tuple
 * and the seed of public.currencies. This test pins them to each other so
 * adding a currency in one place without the other fails CI.
 */
function seededCurrencyCodes(): Set<string> {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const codes = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    if (!/INSERT INTO public\.currencies/i.test(sql)) continue
    for (const m of sql.matchAll(/\(\s*'([A-Z]{3})'\s*,\s*'[^']*'\s*,\s*\d+\s*\)/g)) {
      codes.add(m[1])
    }
  }
  return codes
}

describe('CURRENCIES', () => {
  it('matches the public.currencies seed in supabase/migrations', () => {
    expect(new Set(CURRENCIES)).toEqual(seededCurrencyCodes())
  })

  it('includes CHF', () => {
    expect(CURRENCIES).toContain('CHF')
    expect(FOREIGN_CURRENCIES).toContain('CHF')
    expect(FOREIGN_CURRENCIES).not.toContain('SEK')
    expect(CurrencySchema.safeParse('CHF').success).toBe(true)
  })

  it('includes CAD (Riksbanken series SEKCADPMI)', () => {
    expect(CURRENCIES).toContain('CAD')
    expect(FOREIGN_CURRENCIES).toContain('CAD')
    expect(CurrencySchema.safeParse('CAD').success).toBe(true)
  })

  it('every bookable foreign currency has a Riksbanken rate series', () => {
    // The rate set (RIKSBANKEN_CURRENCIES) is wider than the bookable set: a
    // bank row can be in PLN although no invoice can. The other direction
    // must hold, or a currency offered in a dropdown could never reach SEK.
    for (const c of FOREIGN_CURRENCIES) {
      expect(RIKSBANKEN_CURRENCIES, c).toContain(c)
    }
  })
})
