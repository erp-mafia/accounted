import { describe, it, expect } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { NE_ACCOUNT_RANGES, neRutaForAccount } from '../ne-engine'
import type { NERuta } from '../types'

const CREDIT = -100 // an income balance (debit - credit < 0)
const DEBIT = 100 // a cost balance

/**
 * The BAS kopplingstabell NE_EJ_K1 (NE_EJ_K1-Intervall-231002.xlsx,
 * bas.se/kontoplaner/sru/), column "Konton i BAS 2023", transcribed with
 * plain hyphens. (+) means the row takes the account when its balance is an
 * income, (-) when it is a cost. R1 and R2 share 30xx-37xx and 39xx: the
 * ruta follows the account's VAT status. R3 lists no account.
 */
const OFFICIAL: Record<Exclude<NERuta, 'R3'>, string> = {
  R1: '30xx-37xx, 39xx',
  R2: '30xx-37xx, 39xx',
  R4: '38xx, 801x, 802x(+), 803x(+), 811x, 812x(+), 813x(+), 820x, 821x, 822x(+), 823x(+), 824x(+), 825x, 826x, 829x(+), 830x, 831x, 832x(+), 833x(+), 834x, 835x(+), 836x, 839x, 843x(+), 844x, 845x(+), 849x(+), 881x(+), 886x(+), 888x(+), 889x(+)',
  R5: '40xx-49xx',
  R6: '50xx-69xx',
  R7: '70xx-76xx',
  R8: '774x, 779x, 79xx, 802x(-), 803x(-), 807x, 808x, 812x(-), 813x(-), 817x, 818x, 822x(-), 823x, 824x(-), 827x, 828x, 829x(-), 832x(-), 833x(-), 835x(-), 837x, 838x, 840x, 841x, 842x, 843x(-), 845x(-), 846x, 848x, 849x(-), 881x(-), 886x(-), 888x(-), 889x(-), 89xx (exkl. 899x)',
  R9: '772x, 777x, 782x, 784x, 885x',
  R10: '771x, 773x, 776x, 778x, 781x, 783x, 885x',
}

/** 882x-884x (koncernbidrag, gottgörelser) are absent from the table: mapped like the rest of 88xx. */
const EXTENSIONS = new Set(['882', '883', '884'])

function range(a: number, b: number): string[] {
  const out: string[] = []
  for (let n = a; n <= b; n++) out.push(String(n))
  return out
}

/** Expand "40xx-49xx", "38xx", "801x", "89xx (exkl. 899x)" into account numbers. */
function expand(spec: string): string[] {
  const s = spec.replace(/\((\+|-)\)/, '').trim()
  let m = s.match(/^(\d{2})xx-(\d{2})xx$/)
  if (m) return range(Number(m[1]) * 100, Number(m[2]) * 100 + 99)
  m = s.match(/^(\d{2})xx \(exkl\. (\d{3})x\)$/)
  if (m) {
    const excluded = m[2]
    return range(Number(m[1]) * 100, Number(m[1]) * 100 + 99).filter((n) => !n.startsWith(excluded))
  }
  m = s.match(/^(\d{2})xx$/)
  if (m) return range(Number(m[1]) * 100, Number(m[1]) * 100 + 99)
  m = s.match(/^(\d{3})x$/)
  if (m) return range(Number(m[1]) * 10, Number(m[1]) * 10 + 9)
  throw new Error(`unparsed spec "${spec}"`)
}

/** Per account: the rutor the official table allows for an income and for a cost balance. */
function officialRutor(): Map<string, { income: Set<NERuta>; cost: Set<NERuta> }> {
  const map = new Map<string, { income: Set<NERuta>; cost: Set<NERuta> }>()
  for (const [ruta, specs] of Object.entries(OFFICIAL) as [NERuta, string][]) {
    for (const spec of specs.split(', ')) {
      const sign = spec.includes('(+)') ? '+' : spec.includes('(-)') ? '-' : null
      for (const account of expand(spec)) {
        const entry = map.get(account) ?? { income: new Set<NERuta>(), cost: new Set<NERuta>() }
        if (sign !== '-') entry.income.add(ruta)
        if (sign !== '+') entry.cost.add(ruta)
        map.set(account, entry)
      }
    }
  }
  return map
}

const BAS_RESULT_ACCOUNTS = BAS_REFERENCE.map((a) => a.account_number).filter(
  (n) => /^[3-8]/.test(n) && !n.startsWith('899'),
)

describe('NE_ACCOUNT_RANGES', () => {
  it('are four-digit, sorted and disjoint, so order cannot matter', () => {
    for (let i = 0; i < NE_ACCOUNT_RANGES.length; i++) {
      const r = NE_ACCOUNT_RANGES[i]
      expect(r.start).toMatch(/^\d{4}$/)
      expect(r.end).toMatch(/^\d{4}$/)
      expect(r.start <= r.end).toBe(true)
      if (i > 0) expect(NE_ACCOUNT_RANGES[i - 1].end < r.start).toBe(true)
    }
  })

  it('cover every BAS 2026 class 3-8 account except 899x exactly once', () => {
    expect(BAS_RESULT_ACCOUNTS.length).toBeGreaterThan(700)
    const uncovered: string[] = []
    for (const account of BAS_RESULT_ACCOUNTS) {
      const hits = NE_ACCOUNT_RANGES.filter((r) => account >= r.start && account <= r.end)
      if (hits.length !== 1) uncovered.push(`${account} (${hits.length})`)
    }
    expect(uncovered).toEqual([])
  })

  it('never map 899x, the booked result itself', () => {
    expect(neRutaForAccount('8990', CREDIT)).toBeNull()
    expect(neRutaForAccount('8999', DEBIT)).toBeNull()
  })

  it('follow the official BAS kopplingstabell for every BAS 2026 class 3-8 account', () => {
    const official = officialRutor()
    const mismatches: string[] = []
    for (const account of BAS_RESULT_ACCOUNTS) {
      if (EXTENSIONS.has(account.slice(0, 3))) continue
      const allowed = official.get(account)
      if (!allowed) {
        mismatches.push(`${account}: not in the official table`)
        continue
      }
      const onIncome = neRutaForAccount(account, CREDIT)
      const onCost = neRutaForAccount(account, DEBIT)
      if (!onIncome || !allowed.income.has(onIncome)) mismatches.push(`${account} income: ${onIncome}`)
      if (!onCost || !allowed.cost.has(onCost)) mismatches.push(`${account} cost: ${onCost}`)
    }
    expect(mismatches).toEqual([])
  })
})

describe('neRutaForAccount', () => {
  it.each([
    ['3001', 'R1'],
    ['3004', 'R2'], // Försäljning inom Sverige, momsfri
    ['3100', 'R2'],
    ['3105', 'R1'], // export
    ['3108', 'R1'],
    ['3211', 'R1'], // VMB: momspliktig, R3 has no BAS account
    ['3231', 'R1'], // omvänd moms
    ['3404', 'R2'], // Egna uttag, momsfria
    ['3610', 'R1'],
    ['3740', 'R1'],
    ['3800', 'R4'],
    ['3910', 'R2'],
    ['3913', 'R1'], // Frivilligt momspliktiga hyresintäkter
    ['3914', 'R1'], // Övriga momspliktiga hyresintäkter
    ['3990', 'R2'],
  ])('maps income account %s to %s', (account, ruta) => {
    expect(neRutaForAccount(account, CREDIT)).toBe(ruta)
  })

  it.each([
    ['4010', 'R5'],
    ['6991', 'R6'],
    ['6992', 'R6'],
    ['6999', 'R6'],
    ['7010', 'R7'],
    ['7710', 'R10'],
    ['7720', 'R9'],
    ['7740', 'R8'],
    ['7770', 'R9'],
    ['7820', 'R9'],
    ['7821', 'R9'],
    ['7824', 'R9'],
    ['7829', 'R9'],
    ['7832', 'R10'],
    ['7840', 'R9'],
    ['7960', 'R8'],
    ['7970', 'R8'],
    ['8410', 'R8'],
    ['8851', 'R10'], // överavskrivningar, immateriella
    ['8852', 'R9'], // överavskrivningar, byggnader och markanläggningar
    ['8853', 'R10'], // överavskrivningar, maskiner och inventarier
    ['8910', 'R8'],
  ])('maps cost account %s to %s', (account, ruta) => {
    expect(neRutaForAccount(account, DEBIT)).toBe(ruta)
  })

  it('maps 8210 and 8390 to R4', () => {
    expect(neRutaForAccount('8210', CREDIT)).toBe('R4')
    expect(neRutaForAccount('8390', CREDIT)).toBe('R4')
  })

  it('splits a (+)/(-) account by the sign of its balance', () => {
    expect(neRutaForAccount('8331', CREDIT)).toBe('R4')
    expect(neRutaForAccount('8336', DEBIT)).toBe('R8')
    expect(neRutaForAccount('8860', CREDIT)).toBe('R4')
    expect(neRutaForAccount('8860', DEBIT)).toBe('R8')
  })

  it('keeps a contra balance in the account\'s own ruta', () => {
    // Lämnade rabatter (debit) reduce R1; a credit on a cost account reduces R6.
    expect(neRutaForAccount('3730', DEBIT)).toBe('R1')
    expect(neRutaForAccount('6991', CREDIT)).toBe('R6')
  })

  it('returns null for an account no range covers', () => {
    expect(neRutaForAccount('7750', DEBIT)).toBeNull()
    expect(neRutaForAccount('8470', DEBIT)).toBeNull()
    expect(neRutaForAccount('1930', DEBIT)).toBeNull()
    expect(neRutaForAccount('30011', CREDIT)).toBeNull()
  })
})
