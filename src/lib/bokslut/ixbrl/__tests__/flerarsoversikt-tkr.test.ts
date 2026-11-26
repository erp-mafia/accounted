/**
 * The flerårsöversikt in thousands of kronor (tkr), the year's choice
 * (arsredovisning_narratives.flerarsoversikt_tkr), in the K2 and the K3
 * iXBRL document.
 *
 * Bolagsverket's test criteria for digital filing (Testunderlag K2, taxonomy
 * 2024-09-12) ask for "nettoomsättning i flerårsöversikten som redovisas i
 * tusentals kronor". The tagging is the one of Bolagsverket's K2 example 1
 * (docs/reference/bokslut/exempel/k2/): scale 3 and decimals -3 on an amount
 * in tkr (TA §2.10.3), an exact zero left a whole-krona zero. The
 * resultaträkning tags the same concept and context in whole kronor, which
 * TA §2.7.3 allows when the two values correspond.
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { generateK3IxbrlDocument } from '../document/k3-document'
import type { IxbrlArsredovisningInput } from '../types'
import { makeInput, makeK3Input } from './fixtures'

const MINUS = String.fromCharCode(0x2212)

interface Fact {
  name: string
  contextRef: string
  /** The text between the tags. */
  shown: string
  /** The attributes as written, in order. */
  attrs: string
  /** The value the fact reports: the text, scaled and signed. */
  value: number
  /** The half-width of what the fact claims: 0.5 at decimals 0, 500 at decimals -3. */
  slack: number
  /** A presentational minus right before the element. */
  minusShown: boolean
}

function facts(xhtml: string): Fact[] {
  const out: Fact[] = []
  for (const match of xhtml.matchAll(/(.)<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)) {
    const attr = (key: string) => new RegExp(`(?:^| )${key}="([^"]*)"`).exec(match[2])?.[1]
    const shownNumber = Number(match[3].replace(/\s/g, '').replace(',', '.'))
    const decimals = attr('decimals') ?? '0'
    out.push({
      name: (attr('name') ?? '').replace(/^[^:]+:/, ''),
      contextRef: attr('contextRef') ?? '',
      shown: match[3],
      attrs: match[2],
      value: (attr('sign') === '-' ? -1 : 1) * shownNumber * 10 ** Number(attr('scale') ?? 0),
      slack: decimals === 'INF' ? 0 : 0.5 * 10 ** -Number(decimals),
      minusShown: match[1] === MINUS,
    })
  }
  return out
}

/** The flerårsöversikt table of a document. */
function overview(xhtml: string): string {
  const start = xhtml.indexOf('<th>Flerårsöversikt')
  expect(start).toBeGreaterThan(0)
  return xhtml.slice(start, xhtml.indexOf('</table>', start))
}

function overviewFact(xhtml: string, name: string, contextRef: string): Fact {
  const found = facts(overview(xhtml)).filter((fact) => fact.name === name && fact.contextRef === contextRef)
  expect(found).toHaveLength(1)
  return found[0]
}

/**
 * Facts of one concept and context whose values cannot all be true at once:
 * each fact claims its value within its decimals (a tkr fact within 500 kr),
 * and the claims must overlap. This is how duplicates at different scales are
 * judged (TA §2.7.3; XBRL duplicate facts are consistent when their rounding
 * intervals intersect).
 */
function inconsistentDuplicates(xhtml: string): string[] {
  const groups = new Map<string, Fact[]>()
  for (const fact of facts(xhtml)) {
    const key = `${fact.name}@${fact.contextRef}`
    groups.set(key, [...(groups.get(key) ?? []), fact])
  }
  const out: string[] = []
  for (const [key, group] of groups) {
    const lower = Math.max(...group.map((fact) => fact.value - fact.slack))
    const upper = Math.min(...group.map((fact) => fact.value + fact.slack))
    if (lower > upper) out.push(`${key}: ${group.map((fact) => fact.value).join(' vs ')}`)
  }
  return out
}

/**
 * The fixture with the year's nettoomsättning and resultat efter finansiella
 * poster set in the RR and the overview alike. The resultaträkning still adds
 * up, as the taxonomy's calculation linkbase asks: the operating rows close
 * the gap between the two figures (övriga rörelseintäkter when the result
 * needs more than the revenue gives, övriga externa kostnader when it needs
 * less), and the periodiseringsfond takes the change in the result, so
 * resultat före skatt, årets resultat and the balance sheet stay the
 * fixture's.
 */
function withYearFigures(net: number, result: number, tkr = true): IxbrlArsredovisningInput {
  const input = makeInput()
  const { rr, totals } = input
  const row = (concept: string) => rr[concept]?.current ?? 0
  const setRow = (concept: string, current: number) => {
    rr[concept] = { previous: rr[concept]?.previous ?? null, current }
  }
  const setTotal = (key: keyof typeof totals, current: number) => {
    totals[key] = { ...totals[key], current }
  }
  const rorelseintakter = totals.rorelseintakter.current - row('Nettoomsattning') + net
  const rorelseresultat = result - totals.finansiellaPoster.current
  const gap = rorelseresultat - (rorelseintakter - totals.rorelsekostnader.current)
  const resultChange = result - totals.resultatEfterFinansiellaPoster.current
  setRow('Nettoomsattning', net)
  if (gap > 0) setRow('OvrigaRorelseintakter', row('OvrigaRorelseintakter') + gap)
  if (gap < 0) setRow('OvrigaExternaKostnader', row('OvrigaExternaKostnader') - gap)
  setRow('ForandringPeriodiseringsfond', row('ForandringPeriodiseringsfond') - resultChange)
  setTotal('rorelseintakter', rorelseintakter + Math.max(gap, 0))
  setTotal('rorelsekostnader', totals.rorelsekostnader.current + Math.max(-gap, 0))
  setTotal('rorelseresultat', rorelseresultat)
  setTotal('resultatEfterFinansiellaPoster', result)
  setTotal('bokslutsdispositioner', totals.bokslutsdispositioner.current - resultChange)
  const fb = input.forvaltningsberattelse
  fb.flerarsoversikt[0] = { ...fb.flerarsoversikt[0], nettoomsattning: net, resultatEfterFinansiellaPoster: result }
  if (tkr) fb.flerarsoversiktTkr = true
  return input
}

const TKR_ATTRS = 'unitRef="SEK" decimals="-3" scale="3" format="ixt:numspacecomma"'
const KRONOR_ATTRS = 'unitRef="SEK" decimals="0" scale="0" format="ixt:numspacecomma"'

describe('flerårsöversikt in kronor (the default)', () => {
  const kronor = generateK2IxbrlDocument(makeInput()).xhtml

  it('states whole kronor and says so in the heading', () => {
    const table = overview(kronor)
    expect(table).toContain('<th>Flerårsöversikt (kr)</th>')
    expect(table).not.toContain('scale="3"')
    expect(overviewFact(kronor, 'Nettoomsattning', 'period0')).toMatchObject({ shown: '1 000 000', value: 1_000_000 })
    expect(overviewFact(kronor, 'ResultatEfterFinansiellaPoster', 'period0')).toMatchObject({ shown: '151 340' })
  })

  it('is the same document whether the choice is absent or off', () => {
    const off = makeInput()
    off.forvaltningsberattelse.flerarsoversiktTkr = false
    expect(generateK2IxbrlDocument(off).xhtml).toBe(kronor)
  })
})

describe('flerårsöversikt in tkr', () => {
  const input = makeInput()
  input.forvaltningsberattelse.flerarsoversiktTkr = true
  const { xhtml } = generateK2IxbrlDocument(input)
  const table = overview(xhtml)

  it('is well-formed and says tkr in the heading, with the taxonomy\'s row labels', () => {
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(table).toContain('<th>Flerårsöversikt (tkr)</th>')
    expect(table).not.toContain('Flerårsöversikt (kr)')
    expect(table).toContain('<th>Nettoomsättning</th>')
    expect(table).toContain('<th>Resultat efter finansiella poster</th>')
    expect(table).toContain('<th>Soliditet (%)</th>')
  })

  it('tags nettoomsättning in tkr exactly as Bolagsverket\'s example does (criterion: nettoomsättning i tusentals kronor)', () => {
    // 1 000 000 kr, 500 000 kr and 300 000 kr.
    expect(table).toContain(
      `<ix:nonFraction contextRef="period0" name="se-gen-base:Nettoomsattning" ${TKR_ATTRS}>1 000</ix:nonFraction>`,
    )
    expect(table).toContain(
      `<ix:nonFraction contextRef="period1" name="se-gen-base:Nettoomsattning" ${TKR_ATTRS}>500</ix:nonFraction>`,
    )
    expect(table).toContain(
      `<ix:nonFraction contextRef="period2" name="se-gen-base:Nettoomsattning" ${TKR_ATTRS}>300</ix:nonFraction>`,
    )
    expect(overviewFact(xhtml, 'Nettoomsattning', 'period0').value).toBe(1_000_000)
  })

  it('tags resultat efter finansiella poster in tkr, rounded', () => {
    // 151 340 kr, 60 000 kr and 25 000 kr.
    expect(overviewFact(xhtml, 'ResultatEfterFinansiellaPoster', 'period0')).toMatchObject({ shown: '151', value: 151_000 })
    expect(overviewFact(xhtml, 'ResultatEfterFinansiellaPoster', 'period1')).toMatchObject({ shown: '60', value: 60_000 })
    expect(overviewFact(xhtml, 'ResultatEfterFinansiellaPoster', 'period2')).toMatchObject({ shown: '25', value: 25_000 })
    for (const context of ['period0', 'period1', 'period2']) {
      expect(overviewFact(xhtml, 'ResultatEfterFinansiellaPoster', context).attrs).toContain(TKR_ATTRS)
    }
  })

  it('leaves soliditet a percentage', () => {
    expect(table).toContain(
      '<ix:nonFraction contextRef="balans0" name="se-gen-base:Soliditet" unitRef="procent" decimals="3" scale="-2" format="ixt:numspacecomma">64,5</ix:nonFraction>',
    )
  })

  it('leaves the statements in whole kronor', () => {
    const statements = xhtml.replace(table, '')
    expect(statements).not.toContain('scale="3"')
    expect(statements).not.toContain('decimals="-3"')
    expect(statements).toContain(
      `<ix:nonFraction contextRef="period0" name="se-gen-base:Nettoomsattning" ${KRONOR_ATTRS}>1 000 000</ix:nonFraction>`,
    )
    expect(statements).toContain('Resultaträkning (kr)')
  })

  it('agrees with the resultaträkning, which tags the same concept and context in kronor (TA §2.7.3)', () => {
    expect(facts(xhtml).filter((fact) => fact.name === 'Nettoomsattning' && fact.contextRef === 'period0')).toHaveLength(2)
    expect(inconsistentDuplicates(xhtml)).toEqual([])
  })
})

describe('flerårsöversikt in tkr: rounding, zero and sign', () => {
  it.each([
    [2_650_400, '2 650'],
    [2_650_499, '2 650'],
    // A half is rounded away from zero.
    [2_650_500, '2 651'],
    [1_500, '2'],
    [500, '1'],
    [999_500, '1 000'],
  ])('states %i kr as %s tkr', (kronor, shown) => {
    const { xhtml } = generateK2IxbrlDocument(withYearFigures(kronor, 151_340))
    const fact = overviewFact(xhtml, 'Nettoomsattning', 'period0')
    expect(fact.shown).toBe(shown)
    expect(fact.attrs).toContain(TKR_ATTRS)
    // Never more than 500 kr from the kronor fact of the resultaträkning.
    expect(Math.abs(fact.value - kronor)).toBeLessThanOrEqual(500)
    expect(inconsistentDuplicates(xhtml)).toEqual([])
  })

  it('tags an exact zero as a whole-krona zero, as Bolagsverket\'s example does', () => {
    const { xhtml } = generateK2IxbrlDocument(withYearFigures(0, 151_340))
    const fact = overviewFact(xhtml, 'Nettoomsattning', 'period0')
    expect(fact.shown).toBe('0')
    expect(fact.attrs).toContain(KRONOR_ATTRS)
    expect(fact.attrs).not.toContain('sign=')
    expect(inconsistentDuplicates(xhtml)).toEqual([])
  })

  it.each([499, 1, -499])('prints %i kr as 0 but keeps the tkr precision: a whole-krona zero would contradict the resultaträkning', (kronor) => {
    const { xhtml } = generateK2IxbrlDocument(withYearFigures(1_000_000, kronor))
    const fact = overviewFact(xhtml, 'ResultatEfterFinansiellaPoster', 'period0')
    expect(fact.shown).toBe('0')
    expect(fact.attrs).toContain(TKR_ATTRS)
    // No sign on a zero, whichever side of it the kronor figure is.
    expect(fact.attrs).not.toContain('sign=')
    expect(fact.minusShown).toBe(false)
    expect(inconsistentDuplicates(xhtml)).toEqual([])
  })

  it.each([
    [-4_684, '5', -5_000],
    [-151_340, '151', -151_000],
    // A half is rounded away from zero on a loss too.
    [-1_500, '2', -2_000],
    [-500, '1', -1_000],
  ])('states a loss of %i kr with sign="-" and a minus before the figure', (kronor, shown, value) => {
    const { xhtml } = generateK2IxbrlDocument(withYearFigures(1_000_000, kronor))
    const fact = overviewFact(xhtml, 'ResultatEfterFinansiellaPoster', 'period0')
    expect(fact.shown).toBe(shown)
    expect(fact.value).toBe(value)
    expect(fact.attrs).toContain(`${TKR_ATTRS} sign="-"`)
    expect(fact.minusShown).toBe(true)
    expect(inconsistentDuplicates(xhtml)).toEqual([])
  })

  it('would be caught if the tkr figure did not correspond to the kronor figure', () => {
    // The check itself: a tkr fact 1 000 kr off the resultaträkning is a conflict.
    const input = withYearFigures(2_650_400, 151_340)
    input.forvaltningsberattelse.flerarsoversikt[0].nettoomsattning = 2_651_600
    expect(inconsistentDuplicates(generateK2IxbrlDocument(input).xhtml)).toEqual([
      'Nettoomsattning@period0: 2652000 vs 2650400',
    ])
  })
})

describe('flerårsöversikt in tkr: the K3 document', () => {
  it('states the same table in tkr and stays consistent', () => {
    const input = makeK3Input()
    input.forvaltningsberattelse.flerarsoversiktTkr = true
    const { xhtml } = generateK3IxbrlDocument(input)
    expect(XMLValidator.validate(xhtml)).toBe(true)
    const table = overview(xhtml)
    expect(table).toContain('<th>Flerårsöversikt (tkr)</th>')
    expect(table).toContain(
      `<ix:nonFraction contextRef="period0" name="se-gen-base:Nettoomsattning" ${TKR_ATTRS}>1 000</ix:nonFraction>`,
    )
    expect(xhtml.replace(table, '')).not.toContain('scale="3"')
    expect(inconsistentDuplicates(xhtml)).toEqual([])
  })

  it('states kronor without the choice', () => {
    const table = overview(generateK3IxbrlDocument(makeK3Input()).xhtml)
    expect(table).toContain('<th>Flerårsöversikt (kr)</th>')
    expect(table).not.toContain('scale="3"')
  })
})
