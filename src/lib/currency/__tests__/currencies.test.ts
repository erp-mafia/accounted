import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENCIES, FOREIGN_CURRENCIES } from '@/types'
import { CurrencySchema } from '@/lib/api/schemas'
import { fetchMultipleRates, formatCurrencyAmount } from '@/lib/currency/riksbanken'

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

  it('every foreign currency has a fallback rate and a symbol', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch
    try {
      const rates = await fetchMultipleRates([...FOREIGN_CURRENCIES])
      for (const c of FOREIGN_CURRENCIES) {
        expect(rates.get(c)?.rate, c).toBeGreaterThan(0)
        expect(formatCurrencyAmount(1, c).length).toBeGreaterThan(4)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
