import { describe, it, expect } from 'vitest'
import {
  foldText,
  buildAccountIndex,
  buildActiveAccountIndex,
  searchAccounts,
  type ChartAccountLike,
  type SearchableAccount,
} from '../account-search'

// Synthetic fixtures: `active` is a minimal chart, `catalog` is the full BAS
// superset (and includes the active rows, as the real catalog does).
const active: SearchableAccount[] = [
  { account_number: '1930', account_name: 'Företagskonto', account_class: 1, description: 'Företagets huvudsakliga bankkonto.' },
  { account_number: '5420', account_name: 'Programvaror', account_class: 5, description: 'Kostnader för mjukvara, prenumerationer och licenser.' },
  { account_number: '7010', account_name: 'Lönekostnader tjänstemän', account_class: 7, description: 'Bruttolöner till anställda tjänstemän.' },
]

const catalog: SearchableAccount[] = [
  ...active,
  { account_number: '6540', account_name: 'IT-tjänster', account_class: 6, description: 'Kostnader för extern IT-support, konsultation och drifttjänster.' },
  { account_number: '6550', account_name: 'Konsultarvoden', account_class: 6, description: 'Arvode till externa konsulter för rådgivning.' },
  { account_number: '6230', account_name: 'Datakommunikation', account_class: 6, description: 'Internet, bredband och fast uppkoppling.' },
  { account_number: '6570', account_name: 'Bankkostnader', account_class: 6, description: 'Avgifter för banktjänster och konsultation.' },
]

const idx = buildAccountIndex({ active, catalog })
const numbers = (items: { account_number: string }[]) => items.map((i) => i.account_number)

describe('foldText', () => {
  it('lowercases and strips Swedish diacritics', () => {
    expect(foldText('Lön')).toBe('lon')
    expect(foldText('Intäkter')).toBe('intakter')
    expect(foldText('IT-tjänster')).toBe('it-tjanster')
    expect(foldText('Ränta')).toBe('ranta')
  })
})

describe('searchAccounts', () => {
  it('returns the active chart (only) for an empty query', () => {
    const r = searchAccounts(idx, '')
    expect(numbers(r)).toEqual(['1930', '5420', '7010'])
    expect(r.every((i) => i.isActive)).toBe(true)
  })

  it('finds a catalog-only account by name even when it is not in the chart (the "IT" case)', () => {
    const r = searchAccounts(idx, 'IT')
    expect(numbers(r)).toContain('6540')
    expect(r.find((i) => i.account_number === '6540')?.isActive).toBe(false)
  })

  it('matches words that are not the leading word of the name', () => {
    expect(numbers(searchAccounts(idx, 'kommunikation'))).toContain('6230')
  })

  it('matches words found only in the description', () => {
    // "drifttjänster" appears only in 6540's description, not its name.
    expect(numbers(searchAccounts(idx, 'drifttjänster'))).toEqual(['6540'])
  })

  it('is diacritic-insensitive (query typed without å/ä/ö)', () => {
    expect(numbers(searchAccounts(idx, 'lonekostnader'))).toContain('7010')
    expect(numbers(searchAccounts(idx, 'lon'))).toContain('7010')
  })

  it('requires every token to match (token-AND), regardless of order or hyphen', () => {
    // Both tokens live in 6540 (one in the name, one in the description).
    expect(numbers(searchAccounts(idx, 'drift it'))).toEqual(['6540'])
    // "extern konsultation": 6540 has both in its description; 6550/6570 miss one.
    expect(numbers(searchAccounts(idx, 'extern konsultation'))).toEqual(['6540'])
  })

  it('prefix-matches account numbers across the full catalog', () => {
    const r = searchAccounts(idx, '65')
    expect(numbers(r).sort()).toEqual(['6540', '6550', '6570'])
    expect(r.every((i) => !i.isActive)).toBe(true)
  })

  it('dedupes an account present in both active and catalog, preferring the active row', () => {
    const r = searchAccounts(idx, '1930')
    expect(r).toHaveLength(1)
    expect(r[0].isActive).toBe(true)
  })

  it('ranks active accounts before catalog-only ones', () => {
    const r = searchAccounts(idx, 'kostnad')
    const firstCatalog = r.findIndex((i) => !i.isActive)
    const lastActive = r.map((i) => i.isActive).lastIndexOf(true)
    expect(lastActive).toBeLessThan(firstCatalog)
    // Within active, a name hit outranks a description-only hit.
    expect(r[0].account_number).toBe('7010')
  })

  it('ranks a name "starts-with" hit first', () => {
    // "konsult": 6550 "Konsultarvoden" (name starts) over 6570 (description only).
    const r = searchAccounts(idx, 'konsult')
    expect(r[0].account_number).toBe('6550')
  })

  it('returns nothing for a query that matches no account', () => {
    expect(searchAccounts(idx, 'zzzxyq')).toEqual([])
  })

  it('honours the result limit', () => {
    expect(searchAccounts(idx, '', 2)).toHaveLength(2)
    expect(searchAccounts(idx, '6', 2)).toHaveLength(2)
  })
})

// The booking-dialog picker path (issue #1877): chart rows straight from
// /api/bookkeeping/accounts, indexed active-only, searched by number prefix
// or name. Synthetic fixture mirrors the reported case: 5460 active, plus a
// deactivated sibling that must never surface.
describe('buildActiveAccountIndex', () => {
  const chart: ChartAccountLike[] = [
    { account_number: '1930', account_name: 'Företagskonto', account_class: 1, is_active: true },
    { account_number: '5460', account_name: 'Förbrukningsmaterial', account_class: 5, is_active: true },
    { account_number: '5410', account_name: 'Förbrukningsinventarier', account_class: 5, is_active: false },
    // No is_active flag at all: counts as active (server already filtered).
    { account_number: '6212', account_name: 'Mobiltelefon', account_class: 6 },
  ]
  const activeIdx = buildActiveAccountIndex(chart)

  it('finds an active account by number prefix (the reported "5460" case)', () => {
    expect(numbers(searchAccounts(activeIdx, '5460'))).toEqual(['5460'])
    expect(numbers(searchAccounts(activeIdx, '54'))).toEqual(['5460'])
  })

  it('finds an active account by name, case-insensitively with åäö', () => {
    expect(numbers(searchAccounts(activeIdx, 'Förbrukningsmaterial'))).toEqual(['5460'])
    expect(numbers(searchAccounts(activeIdx, 'FÖRBRUKNINGSMATERIAL'))).toEqual(['5460'])
    expect(numbers(searchAccounts(activeIdx, 'forbrukningsmaterial'))).toEqual(['5460'])
  })

  it('excludes accounts explicitly marked inactive', () => {
    expect(numbers(searchAccounts(activeIdx, '5410'))).toEqual([])
    expect(numbers(searchAccounts(activeIdx, 'Förbrukningsinventarier'))).toEqual([])
  })

  it('treats rows without an is_active flag as active', () => {
    expect(numbers(searchAccounts(activeIdx, 'mobiltelefon'))).toEqual(['6212'])
  })

  it('marks every indexed row as active for the result renderer', () => {
    expect(searchAccounts(activeIdx, '').every((i) => i.isActive)).toBe(true)
  })
})
