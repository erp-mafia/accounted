/**
 * Förändringar i eget kapital in the K2 iXBRL document: one column per
 * equity post, one row per kind of movement, every figure tagged. The chain
 * is the real one, from the year's verifikat through the report's
 * specification (equity-specification.ts) and the document input
 * (k3-adapters.ts) to the table (document/equity-table.ts).
 *
 * The first year is Bolagsverket's test criteria for the table (Testunderlag
 * för K2-årsredovisning, taxonomy 2024-09-12): a dividend with the rest of
 * the result carried forward, a received aktieägartillskott, and a
 * fondemission that takes the bunden överkursfond. The other years are what
 * the criteria leave out: the fri överkursfond, a result that ends on 50
 * öre, the uppskrivningsfond, and movements the taxonomy has no concept for.
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import {
  buildEquitySpecification,
  k2EquityPosts,
  type EquityEntry,
  type EquityYearInput,
} from '@/lib/bokslut/arsredovisning/equity-specification'
import { mapTrialBalancesToK2, type TrialBalancePair, type TrialBalanceRowLike } from '../k2-mapper'
import { k3EquityFromSpecification } from '../k3-adapters'
import { generateK2IxbrlDocument } from '../document/k2-document'
import type { IxbrlArsredovisningInput } from '../types'
import { makeInput } from './fixtures'

// ---- two years of books --------------------------------------------------

/** An equity account's balance per account number, credit-positive (a loss on 2099 is negative). */
type Balances = Record<string, number>

interface Books {
  /** 2024: the equity accounts at the year's start and end, and its equity verifikat. */
  previous: { opening: Balances; closing: Balances; entries: EquityEntry[] }
  /** 2025: the equity accounts at the year's end, its equity verifikat, and what the company owns besides the bank. */
  current: { closing: Balances; entries: EquityEntry[]; assets?: Balances }
}

const ACCOUNT_NAMES: Record<string, string> = {
  '1119': 'Ackumulerade uppskrivningar på byggnader',
  '2081': 'Aktiekapital',
  '2085': 'Uppskrivningsfond',
  '2086': 'Reservfond',
  '2087': 'Bunden överkursfond',
  '2091': 'Balanserad vinst eller förlust',
  '2093': 'Erhållna aktieägartillskott',
  '2097': 'Överkursfond',
  '2099': 'Årets resultat',
}

/** The bank balance of every year here: more than any year's equity. */
const BANK = 1_000_000

const row = (account: string, name: string, debit: number, credit: number): TrialBalanceRowLike => ({
  account_number: account,
  account_name: name,
  closing_debit: debit,
  closing_credit: credit,
})

/**
 * A year's trial balance after and before its closing entry: the equity
 * accounts, the bank, a debt that balances them, and the year's result on
 * one result account (sales in a profit year, rent in a loss year).
 */
function trialBalances(closing: Balances, assets: Balances = {}): TrialBalancePair {
  const result = closing['2099'] ?? 0
  const equity = Object.entries(closing).map(([account, amount]) =>
    row(account, ACCOUNT_NAMES[account], amount < 0 ? -amount : 0, amount > 0 ? amount : 0),
  )
  const owned = Object.entries(assets).map(([account, amount]) => row(account, ACCOUNT_NAMES[account], amount, 0))
  const totalAssets = BANK + Object.values(assets).reduce((sum, amount) => sum + amount, 0)
  const totalEquity = Object.values(closing).reduce((sum, amount) => sum + amount, 0)
  const balance = [
    row('1930', 'Företagskonto', BANK, 0),
    ...owned,
    row('2350', 'Andra långfristiga skulder', 0, totalAssets - totalEquity),
  ]
  const size = Math.abs(result)
  const [account, name] = result < 0 ? ['5010', 'Lokalhyra'] : ['3010', 'Försäljning']
  return {
    full: [...balance, ...equity, row(account, name, size, size)],
    preClosing: [
      ...balance,
      ...equity.filter((r) => r.account_number !== '2099'),
      row(account, name, result < 0 ? size : 0, result < 0 ? 0 : size),
    ],
  }
}

/** The equity accounts as the year's full trial balance holds them: opening and closing. */
function equityRows(opening: Balances, closing: Balances): EquityYearInput['tbRows'] {
  const debit = (amount: number) => (amount < 0 ? -amount : 0)
  const credit = (amount: number) => (amount > 0 ? amount : 0)
  return [...new Set([...Object.keys(opening), ...Object.keys(closing)])].sort().map((account) => ({
    account_number: account,
    opening_debit: debit(opening[account] ?? 0),
    opening_credit: credit(opening[account] ?? 0),
    closing_debit: debit(closing[account] ?? 0),
    closing_credit: credit(closing[account] ?? 0),
  }))
}

let nextEntry = 0
const entry = (lines: Array<[string, number, number]>, extra: Partial<EquityEntry> = {}): EquityEntry => ({
  id: `je-${++nextEntry}`,
  voucher: `A${nextEntry}`,
  entry_date: '2025-05-15',
  description: null,
  source_type: 'manual',
  reverses_id: null,
  lines: lines.map(([account_number, debit, credit]) => ({ account_number, debit, credit })),
  ...extra,
})

/** The year's closing entry: the result accounts against 2099. */
const closingEntry = (year: string, result: number): EquityEntry =>
  entry(result < 0 ? [['2099', -result, 0], ['8999', 0, -result]] : [['8999', result, 0], ['2099', 0, result]], {
    source_type: 'year_end',
    entry_date: `${year}-12-31`,
  })

const POSTS = k2EquityPosts('aktiebolag')

function yearInput(name: string, tbRows: EquityYearInput['tbRows'], entries: EquityEntry[]): EquityYearInput {
  return { fiscal_period_id: `fp-${name}`, name, period_start: `${name}-01-01`, period_end: `${name}-12-31`, tbRows, entries }
}

/**
 * The document input of the books, built as the report builds it: the
 * balance sheet from the trial balances, the specification from the year's
 * verifikat tied to that balance sheet, and the rest of the
 * förvaltningsberättelse repeating the same figures (the same fact in two
 * places is one value).
 */
function buildInput(books: Books): { input: IxbrlArsredovisningInput; specificationWarnings: string[] } {
  const mapping = mapTrialBalancesToK2(
    trialBalances(books.current.closing, books.current.assets),
    trialBalances(books.previous.closing),
  )
  const specification = buildEquitySpecification({
    posts: POSTS,
    current: yearInput('2025', equityRows(books.previous.closing, books.current.closing), books.current.entries),
    previous: yearInput('2024', equityRows(books.previous.opening, books.previous.closing), books.previous.entries),
    balanceSheet: mapping,
    rowLabels: 'k2',
  })
  expect(specification.integrity_issues).toEqual([])

  const input = makeInput()
  input.rr = mapping.rr
  input.br = mapping.br
  input.totals = mapping.totals
  const fb = input.forvaltningsberattelse
  // As buildIxbrlInput passes it: the K2 row labels, the year only.
  fb.egetKapitalSpecifikation = { ...k3EquityFromSpecification(specification, mapping.br, 'k2'), previous: null }
  fb.flerarsoversikt = [
    {
      year: '2025',
      nettoomsattning: mapping.rr['Nettoomsattning']?.current ?? 0,
      resultatEfterFinansiellaPoster: mapping.totals.resultatEfterFinansiellaPoster.current,
      soliditetPct: 30,
    },
    {
      year: '2024',
      nettoomsattning: mapping.rr['Nettoomsattning']?.previous ?? 0,
      resultatEfterFinansiellaPoster: mapping.totals.resultatEfterFinansiellaPoster.previous ?? 0,
      soliditetPct: 20,
    },
  ]
  fb.flerarsPerioder = fb.flerarsPerioder.slice(0, 2)
  const free = {
    balanseratResultat: mapping.br['BalanseratResultat']?.current ?? 0,
    overkursfond: mapping.br['Overkursfond']?.current ?? 0,
    aretsResultat: mapping.br['AretsResultatEgetKapital']?.current ?? 0,
  }
  const summa = free.balanseratResultat + free.overkursfond + free.aretsResultat
  fb.resultatdisposition = {
    ...free,
    summa,
    utdelning: 0,
    balanserasINyRakning: summa,
    kommentar: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
  }
  return { input, specificationWarnings: specification.warnings }
}

// ---- reading the document -----------------------------------------------

interface Fact {
  name: string
  context: string
  /** The fact's value: a sign="-" read as a leading minus. */
  value: string
}

/** Every numeric fact of a document or a part of one. */
function numericFacts(xhtml: string): Fact[] {
  return [...xhtml.matchAll(/<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)].map((match) => ({
    name: /name="[\w-]+:([^"]+)"/.exec(match[1])?.[1] ?? '',
    context: /contextRef="([^"]+)"/.exec(match[1])?.[1] ?? '',
    value: `${/sign="-"/.test(match[1]) ? '-' : ''}${match[2].replace(/\s/g, '')}`,
  }))
}

/** Every tagged fact of a concept as context → value. */
function facts(xhtml: string, name: string): Record<string, string> {
  return Object.fromEntries(numericFacts(xhtml).filter((fact) => fact.name === name).map((fact) => [fact.context, fact.value]))
}

/** Facts with the same concept and context but another value (TA 2.7.1: there must be none). */
function conflictingFacts(xhtml: string): string[] {
  const values = new Map<string, Set<string>>()
  for (const fact of numericFacts(xhtml)) {
    const key = `${fact.name}@${fact.context}`
    values.set(key, (values.get(key) ?? new Set<string>()).add(fact.value))
  }
  expect(values.size).toBeGreaterThan(0)
  return [...values.entries()].filter(([, set]) => set.size > 1).map(([key, set]) => `${key}: ${[...set].join(' vs ')}`)
}

/** How many times the document tags a concept in a context. */
const occurrences = (xhtml: string, name: string, context: string): number =>
  numericFacts(xhtml).filter((fact) => fact.name === name && fact.context === context).length

/** A presentational minus sits right before the fact: the figure reduces equity. */
function shownAsDecrease(xhtml: string, name: string): boolean {
  const index = xhtml.search(new RegExp(`<ix:nonFraction contextRef="period0" name="se-gen-base:${name}"`))
  expect(index).toBeGreaterThan(0)
  return xhtml[index - 1] === '−'
}

function equityTable(xhtml: string): string {
  const start = xhtml.indexOf('<th>Förändringar i eget kapital</th>')
  expect(start).toBeGreaterThan(0)
  return xhtml.slice(start, xhtml.indexOf('</table>', start))
}

/** The table's rows under its heading as a reader sees them: the label and each cell's figure, a blank cell as null. */
function printedRows(table: string): Array<{ label: string; cells: Array<number | null> }> {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => ({
    label: /<th>([^<]*)<\/th>/.exec(match[1])?.[1] ?? '',
    cells: [...match[1].matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map((cell) => {
      const text = cell[1].replace(/<[^>]+>/g, '').replace(/\s/g, '')
      return text === '' ? null : Number(text.replace('−', '-'))
    }),
  }))
}

const printedRow = (table: string, label: string) => printedRows(table).find((r) => r.label === label)?.cells

/** Columns that do not add up as printed: the opening and every row down to the closing. */
function columnsThatDoNotAddUp(table: string): string[] {
  const rows = printedRows(table)
  const opening = rows.find((r) => r.label === 'Belopp vid årets ingång')
  const closing = rows.find((r) => r.label === 'Belopp vid årets utgång')
  if (!opening || !closing) throw new Error('the table has no opening or no closing row')
  const movements = rows.filter((r) => r !== opening && r !== closing)
  expect(movements.length).toBeGreaterThan(0)
  return closing.cells.flatMap((end, column) => {
    const sum = (opening.cells[column] ?? 0) + movements.reduce((total, r) => total + (r.cells[column] ?? 0), 0)
    return sum === end ? [] : [`column ${column}: ${sum} is not ${end}`]
  })
}

const equityWarnings = (warnings: string[]) => warnings.filter((warning) => warning.startsWith('Förändringar i eget kapital'))

// ---- the test criteria ---------------------------------------------------

// 2024 closed with aktiekapital 25 000, bunden överkursfond 100 000,
// balanserat resultat 60 000 and a result of 40 000. In 2025 the stämma pays
// 10 000 of that result as dividend and carries 30 000 forward; the owner
// gives an unconditional tillskott of 40 000; a fondemission moves the
// bunden överkursfond into the aktiekapital; the year's result is 120 000.
const CRITERIA_YEAR: Books = {
  previous: {
    opening: { '2081': 25_000, '2087': 100_000, '2091': 60_000 },
    closing: { '2081': 25_000, '2087': 100_000, '2091': 60_000, '2099': 40_000 },
    entries: [closingEntry('2024', 40_000)],
  },
  current: {
    closing: { '2081': 125_000, '2091': 90_000, '2093': 40_000, '2099': 120_000 },
    entries: [
      entry([['2099', 40_000, 0], ['2898', 0, 10_000], ['2091', 0, 30_000]], { description: 'Årsstämmans disposition' }),
      entry([['1930', 40_000, 0], ['2093', 0, 40_000]], { description: 'Aktieägartillskott' }),
      entry([['2087', 100_000, 0], ['2081', 0, 100_000]], { description: 'Fondemission' }),
      closingEntry('2025', 120_000),
    ],
  },
}

describe('K2 document: förändringar i eget kapital per post', () => {
  const { input, specificationWarnings } = buildInput(CRITERIA_YEAR)
  const { xhtml, warnings } = generateK2IxbrlDocument(input)
  const table = equityTable(xhtml)

  it('is well-formed and leaves nothing untagged', () => {
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(specificationWarnings).toEqual([])
    expect(equityWarnings(warnings)).toEqual([])
    // Every cell that holds a figure holds a fact.
    const figures = printedRows(table).flatMap((r) => r.cells).filter((cell) => cell !== null)
    expect(figures.length).toBeGreaterThan(20)
    expect(numericFacts(table)).toHaveLength(figures.length)
  })

  it('has one column per post that holds anything, and the K2 taxonomy\'s row labels', () => {
    const headers = [...table.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1])
    expect(headers).toEqual([
      'Förändringar i eget kapital',
      'Aktiekapital',
      'Bunden överkursfond',
      'Balanserat resultat',
      'Årets resultat',
      'Totalt',
      'Belopp vid årets ingång',
      'Balanseras i ny räkning',
      'Vinstutdelning',
      'Erhållna aktieägartillskott',
      'Fondemission',
      'Årets resultat',
      'Belopp vid årets utgång',
    ])
  })

  it('opens and closes each post with the balance sheet\'s own figures', () => {
    expect(facts(table, 'Aktiekapital')).toEqual({ balans1: '25000', balans0: '125000' })
    expect(facts(table, 'OverkursfondBunden')).toEqual({ balans1: '100000', balans0: '0' })
    expect(facts(table, 'BalanseratResultat')).toEqual({ balans1: '60000', balans0: '130000' })
    expect(facts(table, 'AretsResultatEgetKapital')).toEqual({ balans1: '40000', balans0: '120000' })
    expect(facts(table, 'EgetKapital')).toEqual({ balans1: '225000', balans0: '375000' })
    expect(input.br['Aktiekapital']).toEqual({ previous: 25_000, current: 125_000 })
    expect(input.br['BalanseratResultat']).toEqual({ previous: 60_000, current: 130_000 })
  })

  it('repeats no fact with another value anywhere in the document (TA 2.7.1)', () => {
    // The balance sheet, the table and the resultatdisposition tag the same balance.
    expect(occurrences(xhtml, 'BalanseratResultat', 'balans0')).toBe(3)
    expect(occurrences(xhtml, 'EgetKapital', 'balans1')).toBe(2)
    expect(conflictingFacts(xhtml)).toEqual([])
  })

  it('tags a dividend from last year\'s result and the rest carried forward (criterion: utdelning och balansering)', () => {
    // "Minskning av periodens resultat vid utdelning": a positive fact, shown with a minus.
    expect(facts(table, 'ForandringEgetKapitalAretsResultatUtdelning')).toEqual({ period0: '10000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalAretsResultatUtdelning')).toBe(true)
    expect(facts(table, 'ForandringEgetKapitalTotaltUtdelning')).toEqual({ period0: '10000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalTotaltUtdelning')).toBe(true)
    // "Ökning (minskning) ... vid balansering i ny räkning": signed.
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '30000' })
    expect(facts(table, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '-30000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({ period0: '0' })
  })

  it('tags a received aktieägartillskott (criterion: erhållet aktieägartillskott)', () => {
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatErhallnaAktieagartillskott')).toEqual({ period0: '40000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltErhallnaAktieagartillskott')).toEqual({ period0: '40000' })
  })

  it('tags a fondemission that takes the bunden överkursfond (criterion: fondemission)', () => {
    expect(facts(table, 'ForandringEgetKapitalAktiekapitalFondemission')).toEqual({ period0: '100000' })
    // "Minskning av bunden överkursfond vid fondemission": a positive fact, shown with a minus.
    expect(facts(table, 'ForandringEgetKapitalBundenOverkursfondFondemission')).toEqual({ period0: '100000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalBundenOverkursfondFondemission')).toBe(true)
    expect(facts(table, 'ForandringEgetKapitalTotaltFondemission')).toEqual({ period0: '0' })
  })

  it('tags the year\'s result', () => {
    expect(facts(table, 'ForandringEgetKapitalAretsResultatAretsResultat')).toEqual({ period0: '120000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltAretsResultat')).toEqual({ period0: '120000' })
  })

  it('adds up as printed: each column from its opening through every row to its closing', () => {
    // Aktiekapital, Bunden överkursfond, Balanserat resultat, Årets resultat, Totalt.
    expect(printedRow(table, 'Belopp vid årets ingång')).toEqual([25_000, 100_000, 60_000, 40_000, 225_000])
    expect(printedRow(table, 'Vinstutdelning')).toEqual([null, null, null, -10_000, -10_000])
    expect(printedRow(table, 'Fondemission')).toEqual([100_000, -100_000, null, null, 0])
    expect(printedRow(table, 'Belopp vid årets utgång')).toEqual([125_000, 0, 130_000, 120_000, 375_000])
    expect(columnsThatDoNotAddUp(table)).toEqual([])
  })
})

// ---- what the criteria leave out ----------------------------------------

describe('K2 document: the fri överkursfond', () => {
  // 2024 closed with a loss of 30 000. In 2025 the stämma covers it from the
  // fri överkursfond and pays 20 000 of the fund as dividend, 20 000 of an
  // earlier tillskott is repaid, and a nyemission brings 10 000 in
  // aktiekapital and 90 000 over par to the fri överkursfond.
  const { input, specificationWarnings } = buildInput({
    previous: {
      opening: { '2081': 25_000, '2093': 50_000, '2097': 200_000 },
      closing: { '2081': 25_000, '2093': 50_000, '2097': 200_000, '2099': -30_000 },
      entries: [closingEntry('2024', -30_000)],
    },
    current: {
      closing: { '2081': 35_000, '2093': 30_000, '2097': 240_000, '2099': 10_000 },
      entries: [
        entry([['2097', 30_000, 0], ['2099', 0, 30_000]], { description: 'Förlusten täcks av överkursfonden' }),
        entry([['2097', 20_000, 0], ['2898', 0, 20_000]], { description: 'Utdelning' }),
        entry([['2093', 20_000, 0], ['1930', 0, 20_000]], { description: 'Återbetalt aktieägartillskott' }),
        entry([['1930', 100_000, 0], ['2081', 0, 10_000], ['2097', 0, 90_000]], { description: 'Nyemission' }),
        closingEntry('2025', 10_000),
      ],
    },
  })
  const { xhtml, warnings } = generateK2IxbrlDocument(input)
  const table = equityTable(xhtml)

  it('tags every movement of the fund, a decrease as a positive fact shown with a minus', () => {
    expect(specificationWarnings).toEqual([])
    expect(equityWarnings(warnings)).toEqual([])
    // "Minskning av fri överkursfond vid balansering i ny räkning" and "... vid utdelning".
    expect(facts(table, 'ForandringEgetKapitalOverkursfondBalanserasNyRakning')).toEqual({ period0: '30000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalOverkursfondBalanserasNyRakning')).toBe(true)
    expect(facts(table, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '30000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({ period0: '0' })
    expect(facts(table, 'ForandringEgetKapitalOverkursfondUtdelning')).toEqual({ period0: '20000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalOverkursfondUtdelning')).toBe(true)
    // "Ökning av fri överkursfond vid nyemission".
    expect(facts(table, 'ForandringEgetKapitalOverkursfondNyemission')).toEqual({ period0: '90000' })
    expect(facts(table, 'ForandringEgetKapitalAktiekapitalNyemission')).toEqual({ period0: '10000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltNyemission')).toEqual({ period0: '100000' })
    // "Minskning av balanserat resultat vid återbetalning av aktieägartillskott".
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatAterbetalningAktieagartillskott')).toEqual({ period0: '20000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalBalanseratResultatAterbetalningAktieagartillskott')).toBe(true)
    expect(facts(table, 'ForandringEgetKapitalTotaltAterbetalningAktieagartillskott')).toEqual({ period0: '20000' })
  })

  it('opens a loss on Årets resultat as a negative balance and adds up as printed', () => {
    expect(facts(table, 'AretsResultatEgetKapital')).toEqual({ balans1: '-30000', balans0: '10000' })
    expect(facts(table, 'Overkursfond')).toEqual({ balans1: '200000', balans0: '240000' })
    expect(columnsThatDoNotAddUp(table)).toEqual([])
  })

  it('repeats no fact with another value: the fund is in the balance sheet, the table and the resultatdisposition', () => {
    expect(occurrences(xhtml, 'Overkursfond', 'balans0')).toBe(3)
    expect(conflictingFacts(xhtml)).toEqual([])
  })
})

describe('K2 document: a result that ends on 50 öre', () => {
  // 2024's result is 40 000,50 and 2025's a loss of 20 000,50: each rounds
  // away from zero in the balance sheet, so the 40 001 that leaves Årets
  // resultat is the 40 001 that reaches Balanserat resultat.
  const { input, specificationWarnings } = buildInput({
    previous: {
      opening: { '2081': 25_000, '2091': 60_000 },
      closing: { '2081': 25_000, '2091': 60_000, '2099': 40_000.5 },
      entries: [closingEntry('2024', 40_000.5)],
    },
    current: {
      closing: { '2081': 25_000, '2091': 100_000.5, '2099': -20_000.5 },
      entries: [entry([['2099', 40_000.5, 0], ['2091', 0, 40_000.5]]), closingEntry('2025', -20_000.5)],
    },
  })
  const { xhtml, warnings } = generateK2IxbrlDocument(input)
  const table = equityTable(xhtml)

  it('carries the result forward without a krona left on the row', () => {
    expect(specificationWarnings).toEqual([])
    expect(equityWarnings(warnings)).toEqual([])
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '40001' })
    expect(facts(table, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '-40001' })
    expect(facts(table, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({ period0: '0' })
  })

  it('shows the year\'s result the income statement shows', () => {
    expect(facts(xhtml, 'AretsResultat')['period0']).toBe('-20001')
    expect(facts(table, 'ForandringEgetKapitalAretsResultatAretsResultat')).toEqual({ period0: '-20001' })
    expect(facts(table, 'ForandringEgetKapitalTotaltAretsResultat')).toEqual({ period0: '-20001' })
    expect(columnsThatDoNotAddUp(table)).toEqual([])
    expect(conflictingFacts(xhtml)).toEqual([])
  })
})

describe('K2 document: the uppskrivningsfond', () => {
  const previous: Books['previous'] = {
    opening: { '2081': 25_000, '2085': 100_000, '2091': 60_000 },
    closing: { '2081': 25_000, '2085': 100_000, '2091': 60_000, '2099': 40_000 },
    entries: [closingEntry('2024', 40_000)],
  }

  it('tags an uppskrivning, and a fondemission out of the fund with the concept the taxonomy spells without the l', () => {
    const { input } = buildInput({
      previous,
      current: {
        closing: { '2081': 75_000, '2085': 120_000, '2091': 100_000, '2099': 5_000 },
        assets: { '1119': 70_000 },
        entries: [
          entry([['2099', 40_000, 0], ['2091', 0, 40_000]]),
          entry([['1119', 70_000, 0], ['2085', 0, 70_000]], { description: 'Uppskrivning av byggnad' }),
          entry([['2085', 50_000, 0], ['2081', 0, 50_000]], { description: 'Fondemission' }),
          closingEntry('2025', 5_000),
        ],
      },
    })
    const { xhtml, warnings } = generateK2IxbrlDocument(input)
    const table = equityTable(xhtml)
    expect(equityWarnings(warnings)).toEqual([])
    // "Ökning av uppskrivningsfond vid uppskrivning av anläggningstillgång".
    expect(facts(table, 'ForandringEgetKapitalUppskrivningsfondUppskrivningAnlaggningstillgang')).toEqual({ period0: '70000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltUppskrivningAnlaggningstillgang')).toEqual({ period0: '70000' })
    // "Minskning av uppskrivningsfond vid fondemission": ForandringEgetKapita..., as the taxonomy has it.
    expect(facts(table, 'ForandringEgetKapitaUppskrivningsfondFondemission')).toEqual({ period0: '50000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitaUppskrivningsfondFondemission')).toBe(true)
    expect(facts(table, 'ForandringEgetKapitalUppskrivningsfondFondemission')).toEqual({})
    expect(facts(table, 'ForandringEgetKapitalAktiekapitalFondemission')).toEqual({ period0: '50000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltFondemission')).toEqual({ period0: '0' })
    // Aktiekapital, Uppskrivningsfond, Balanserat resultat, Årets resultat, Totalt.
    expect(printedRow(table, 'Uppskrivning av anläggningstillgång')).toEqual([null, 70_000, null, null, 70_000])
    expect(printedRow(table, 'Fondemission')).toEqual([50_000, -50_000, null, null, 0])
    expect(columnsThatDoNotAddUp(table)).toEqual([])
    expect(conflictingFacts(xhtml)).toEqual([])
  })

  it('prints a write-down against the fund untagged: the concept is the increase by an uppskrivning', () => {
    // 30 000 of an earlier uppskrivning is taken back against the fund. The
    // specification shows it on the uppskrivning row; the taxonomy's concept
    // there is "Ökning av uppskrivningsfond ...", which a decrease is not.
    const { input } = buildInput({
      previous,
      current: {
        closing: { '2081': 25_000, '2085': 70_000, '2091': 100_000, '2099': 5_000 },
        assets: { '1119': 70_000 },
        entries: [
          entry([['2099', 40_000, 0], ['2091', 0, 40_000]]),
          entry([['2085', 30_000, 0], ['1119', 0, 30_000]], { description: 'Nedskrivning av uppskriven byggnad' }),
          closingEntry('2025', 5_000),
        ],
      },
    })
    const { xhtml, warnings } = generateK2IxbrlDocument(input)
    const table = equityTable(xhtml)
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(numericFacts(xhtml).filter((fact) => fact.name.endsWith('UppskrivningAnlaggningstillgang'))).toEqual([])
    expect(printedRow(table, 'Uppskrivning av anläggningstillgång')).toEqual([null, -30_000, null, null, -30_000])
    expect(equityWarnings(warnings)).toEqual([
      'Förändringar i eget kapital: Uppskrivning av anläggningstillgång (Uppskrivningsfond), Uppskrivning av anläggningstillgång (totalt) har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.',
    ])
    // The rest of the table is tagged, and it still adds up as printed.
    expect(facts(table, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({ period0: '0' })
    expect(facts(table, 'Uppskrivningsfond')).toEqual({ balans1: '100000', balans0: '70000' })
    expect(columnsThatDoNotAddUp(table)).toEqual([])
  })
})

describe('K2 document: what the table does without a concept, a post or a specification', () => {
  /** The criteria year's input, with its specification at hand to change. */
  function criteriaYear() {
    const { input } = buildInput(CRITERIA_YEAR)
    const specification = input.forvaltningsberattelse.egetKapitalSpecifikation
    if (!specification) throw new Error('the input carries no specification')
    const post = (concept: string) => {
      const found = specification.posts.find((p) => p.concept === concept)
      if (!found) throw new Error(`the specification has no ${concept}`)
      return found
    }
    return { input, specification, post }
  }

  it('prints a movement the K2 taxonomy has no row for untagged, and says so', () => {
    const { input, specification, post } = criteriaYear()
    // 5 000 moved from balanserat resultat to the reservfond: no single row of the taxonomy.
    specification.kinds.push({ kind: 'omforing', label: 'Omföring mellan poster i eget kapital' })
    post('BalanseratResultat').movements.omforing = -5_000
    specification.posts.push({ concept: 'Reservfond', label: 'Reservfond', bound: true, opening: 0, closing: 0, movements: { omforing: 5_000 } })
    const { xhtml, warnings } = generateK2IxbrlDocument(input)
    expect(XMLValidator.validate(xhtml)).toBe(true)
    // Aktiekapital, Bunden överkursfond, Balanserat resultat, Årets resultat, Reservfond, Totalt.
    expect(printedRow(equityTable(xhtml), 'Omföring mellan poster i eget kapital')).toEqual([null, null, -5_000, null, 5_000, 0])
    expect(equityWarnings(warnings)).toEqual([
      'Förändringar i eget kapital: Omföring mellan poster i eget kapital (Balanserat resultat), Omföring mellan poster i eget kapital (Reservfond), Omföring mellan poster i eget kapital (totalt) har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.',
    ])
  })

  it('prints a krona that rounding leaves on a transfer\'s total untagged: the concept is a change within eget kapital', () => {
    const { input, post } = criteriaYear()
    // The 30 000 carried forward, printed as 30 000 out and 30 001 in.
    post('BalanseratResultat').movements.resultatdisposition = 30_001
    const { xhtml, warnings } = generateK2IxbrlDocument(input)
    const table = equityTable(xhtml)
    expect(facts(table, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({})
    expect(printedRow(table, 'Balanseras i ny räkning')).toEqual([null, null, 30_001, -30_000, 1])
    expect(equityWarnings(warnings)).toEqual([
      'Förändringar i eget kapital: Balanseras i ny räkning (totalt) har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.',
    ])
    // The posts' own facts stay: each says what moved on its post.
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '30001' })
    expect(facts(table, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '-30000' })
  })

  it('prints an increase on a row whose concept is a decrease untagged', () => {
    const { input, post } = criteriaYear()
    // A verifikat called a dividend that raises Balanserat resultat.
    post('BalanseratResultat').movements.utdelning = 2_000
    const { xhtml, warnings } = generateK2IxbrlDocument(input)
    const table = equityTable(xhtml)
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatUtdelning')).toEqual({})
    // The row's other post and its total still decrease: tagged as before.
    expect(facts(table, 'ForandringEgetKapitalAretsResultatUtdelning')).toEqual({ period0: '10000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltUtdelning')).toEqual({ period0: '8000' })
    expect(printedRow(table, 'Vinstutdelning')).toEqual([null, null, 2_000, -10_000, -8_000])
    expect(equityWarnings(warnings)).toEqual([
      'Förändringar i eget kapital: Vinstutdelning (Balanserat resultat) har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.',
    ])
  })

  it('keeps the collapsed table for an input without the specification (a version locked before it)', () => {
    const input = makeInput()
    expect(input.forvaltningsberattelse.egetKapitalSpecifikation).toBeUndefined()
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(facts(xhtml, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '40000' })
  })

  it('keeps the collapsed table for a specification without a post', () => {
    const input = makeInput()
    input.forvaltningsberattelse.egetKapitalSpecifikation = { source: 'ledger', kinds: [], posts: [], placement: 'management_report', previous: null }
    const withEmpty = generateK2IxbrlDocument(input).xhtml
    expect(withEmpty).toBe(generateK2IxbrlDocument(makeInput()).xhtml)
  })

  it('keeps the collapsed table for a post the document\'s taxonomy does not hold (an ekonomisk förening\'s insatser)', () => {
    // The specification of an ekonomisk förening carries Medlemsinsatser,
    // which the aktiebolag's taxonomy has no concept for: the document is
    // generated as before, it does not fail on the post.
    const input = makeInput()
    input.forvaltningsberattelse.egetKapitalSpecifikation = {
      source: 'ledger',
      kinds: [
        { kind: 'insatser_inbetalda', label: 'Inbetalda insatser' },
        { kind: 'arets_resultat', label: 'Årets resultat' },
      ],
      posts: [
        { concept: 'Medlemsinsatser', label: 'Medlemsinsatser', bound: true, opening: 20_000, closing: 25_000, movements: { insatser_inbetalda: 5_000 } },
        { concept: 'AretsResultatEgetKapital', label: 'Årets resultat', bound: false, opening: 0, closing: 120_000, movements: { arets_resultat: 120_000 } },
      ],
      placement: 'management_report',
      previous: null,
    }
    const generated = generateK2IxbrlDocument(input)
    const collapsed = generateK2IxbrlDocument(makeInput())
    expect(generated.xhtml).toBe(collapsed.xhtml)
    expect(generated.warnings).toEqual(collapsed.warnings)
  })
})
