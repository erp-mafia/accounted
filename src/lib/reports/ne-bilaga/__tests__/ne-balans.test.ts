import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import official from '../official-ne-fields.json'
import { NE_BALANCE_RANGES, neBalansFromBalances, neBalansRutaForAccount } from '../ne-engine'
import { NE_BALANS_FIELD_CODES, NE_SRU_FIELD_CODES, R12_FIELD_CODE, R13_FIELD_CODE, R14_FIELD_CODE } from '../sru-generator'
import type { NEBalansRuta } from '../types'

/**
 * The balansräkning column of BAS kopplingstabell NE_EJ_K1
 * (NE_EJ_K1-Intervall-231002, "Konton i BAS 2023"), transcribed with plain
 * hyphens. B14 Skatteskulder lists no account ("Inget redovisas här").
 */
const OFFICIAL: Record<Exclude<NEBalansRuta, 'B14'>, string> = {
  B1: '10xx',
  B2: '1100-1129, 1150-1179, 1190-1199',
  B3: '113x, 114x, 118x, 1291',
  B4: '1200-1290, 1292-1299',
  B5: '13xx',
  B6: '14xx',
  B7: '15xx',
  B8: '16xx-18xx',
  B9: '19xx',
  B10: '201x, 205x',
  B11: '21xx',
  B12: '22xx',
  B13: '23xx, 241x, 248x',
  B15: '2440-2449, 2460-2479',
  B16: '2420-2439, 2450-2459, 2490-2499, 26xx-29xx',
}

function span(a: number, b: number): string[] {
  return Array.from({ length: b - a + 1 }, (_, i) => String(a + i))
}

function expand(spec: string): string[] {
  let m = spec.match(/^(\d{2})xx-(\d{2})xx$/)
  if (m) return span(Number(m[1]) * 100, Number(m[2]) * 100 + 99)
  m = spec.match(/^(\d{2})xx$/)
  if (m) return span(Number(m[1]) * 100, Number(m[1]) * 100 + 99)
  m = spec.match(/^(\d{3})x$/)
  if (m) return span(Number(m[1]) * 10, Number(m[1]) * 10 + 9)
  m = spec.match(/^(\d{4})-(\d{4})$/)
  if (m) return span(Number(m[1]), Number(m[2]))
  m = spec.match(/^(\d{4})$/)
  if (m) return [m[1]]
  throw new Error(`unparsed spec "${spec}"`)
}

const officialRuta = new Map<string, NEBalansRuta>()
for (const [ruta, specs] of Object.entries(OFFICIAL) as Array<[NEBalansRuta, string]>) {
  for (const spec of specs.split(', ')) {
    for (const account of expand(spec)) {
      expect(officialRuta.has(account), `${account} listed twice`).toBe(false)
      officialRuta.set(account, ruta)
    }
  }
}

describe('NE balansräkning ranges against BAS kopplingstabell NE_EJ_K1', () => {
  it('sends every BAS 2026 class 1-2 account where the table does, and no other', () => {
    const balanceAccounts = BAS_REFERENCE.map((a) => a.account_number).filter((n) => /^[12]/.test(n))
    expect(balanceAccounts.length).toBeGreaterThan(300)
    const wrong = balanceAccounts
      .map((n) => [n, neBalansRutaForAccount(n), officialRuta.get(n) ?? null] as const)
      .filter(([, got, want]) => got !== want)
    expect(wrong).toEqual([])
  })

  it('has disjoint, sorted ranges', () => {
    for (let i = 1; i < NE_BALANCE_RANGES.length; i++) {
      expect(NE_BALANCE_RANGES[i].start > NE_BALANCE_RANGES[i - 1].end).toBe(true)
    }
  })
})

describe('neBalansFromBalances', () => {
  const names = new Map<string, string>()

  it('files assets debit-positive, liabilities credit-positive and B10 as the difference', () => {
    const balances = new Map<string, number>([
      ['1220', 60_000], // Inventarier
      ['1229', -12_000], // Ackumulerade avskrivningar
      ['1510', 25_000.75], // Kundfordringar
      ['1630', 3_000], // Skattekonto
      ['1930', 81_500.5], // Företagskonto
      ['2010', -100_000], // Eget kapital: B10 is not summed
      ['2013', 40_000], // Egna uttag
      ['2350', -50_000], // Lån
      ['2440', -9_000], // Leverantörsskulder
      ['2611', -15_000.25], // Utgående moms
      ['3001', -500_000], // A result account: not on the balansräkning
    ])

    const { balans, breakdown, unmapped } = neBalansFromBalances(balances, names)

    expect(balans).toMatchObject({ B4: 48_000, B7: 25_000, B8: 3_000, B9: 81_500, B13: 50_000, B15: 9_000, B16: 15_000, B14: 0 })
    // 48 000 + 25 000 + 3 000 + 81 500 - (50 000 + 9 000 + 15 000)
    expect(balans.B10).toBe(83_500)
    expect(breakdown.B4.accounts.map((a) => a.accountNumber)).toEqual(['1220', '1229'])
    expect(breakdown.B10.accounts).toEqual([])
    expect(unmapped).toEqual([])
  })

  it('names a balance account the table does not cover and leaves it inside B10', () => {
    const { balans, unmapped } = neBalansFromBalances(
      new Map([['1930', 10_000], ['2510', -2_000]]),
      new Map([['2510', 'Skatteskulder']]),
    )
    expect(unmapped).toEqual([{ accountNumber: '2510', accountName: 'Skatteskulder', balance: -2_000 }])
    expect(balans.B14).toBe(0)
    expect(balans.B10).toBe(10_000)
  })

  it('takes any class 20 account as eget kapital, the aktiebolag ones an imported chart carries included', () => {
    // Books imported from another system often carry the result on 2099 and
    // earlier results on 2091; they are equity, so they are in B10 and not named.
    const { balans, unmapped } = neBalansFromBalances(
      new Map([['1930', 50_000], ['2440', -8_000], ['2099', -30_000], ['2091', -12_000], ['2010', 0]]),
      new Map(),
    )
    expect(unmapped).toEqual([])
    expect(balans.B9).toBe(50_000)
    expect(balans.B15).toBe(8_000)
    expect(balans.B10).toBe(42_000)
  })
})

describe('NE field codes against Skatteverket field-name tables', () => {
  const tables = official.tables as Record<string, { fields: Record<string, { row: string | null }> }>

  it.each(Object.keys(tables))('emits only codes that exist in %s, each on its row', (period) => {
    const fields = tables[period].fields
    for (const [ruta, code] of [...Object.entries(NE_BALANS_FIELD_CODES), ...Object.entries(NE_SRU_FIELD_CODES)]) {
      expect(fields[code]?.row, `${ruta} on ${code}`).toBe(ruta)
    }
    expect(fields[R12_FIELD_CODE]?.row).toBe('R12')
    expect(fields[R13_FIELD_CODE]?.row).toBe('R13')
    expect(fields[R14_FIELD_CODE]?.row).toBe('R14')
  })
})
