/**
 * The equity table both documents print (document/equity-table.ts), under
 * each taxonomy: the K2 and the K3 registry name the movement concepts
 * alike, so what one document tags the other tags the same way. The K2
 * document's own tests (k2-equity-table.test.ts) reach the table through
 * the report's specification; these call it with the posts directly.
 */
import { describe, expect, it } from 'vitest'
import { renderEquityTable } from '../document/equity-table'
import { FactWriter } from '../document/ix'
import { CSS } from '../document/layout'
import { getEntryPoint } from '../taxonomy/entry-points'
import { getRegistry } from '../taxonomy/registry'
import type { K3EquityInput, K3EquityPost } from '../types'

const post = (
  concept: string,
  label: string,
  opening: number,
  movements: Record<string, number>,
): K3EquityPost => ({
  concept,
  label,
  bound: false,
  opening,
  closing: opening + Object.values(movements).reduce((sum, amount) => sum + amount, 0),
  movements,
})

function render(entryPointId: string, kinds: K3EquityInput['kinds'], posts: K3EquityPost[]) {
  const entryPoint = getEntryPoint(entryPointId)
  const registry = getRegistry(entryPoint.registryId)
  const writer = new FactWriter(entryPoint, registry, '556999-9997')
  writer.addDurationContext('period0', '2025-01-01', '2025-12-31')
  writer.addInstantContext('balans0', '2025-12-31')
  writer.addInstantContext('balans1', '2024-12-31')
  const warnings: string[] = []
  const table = renderEquityTable(writer, registry, { kinds }, posts, { period: 'period0', opening: 'balans1', closing: 'balans0' }, warnings)
  return { table, warnings }
}

/** The facts of a concept as context → value, a sign="-" read as a leading minus. */
function facts(table: string, name: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of table.matchAll(/<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)) {
    if (!match[1].includes(`name="se-gen-base:${name}"`)) continue
    const context = /contextRef="([^"]+)"/.exec(match[1])?.[1] ?? ''
    out[context] = `${/sign="-"/.test(match[1]) ? '-' : ''}${match[2].replace(/\s/g, '')}`
  }
  return out
}

/** A presentational minus sits right before the fact. */
function shownAsDecrease(table: string, name: string): boolean {
  const index = table.search(new RegExp(`<ix:nonFraction contextRef="period0" name="se-gen-base:${name}"`))
  expect(index).toBeGreaterThan(0)
  return table[index - 1] === '−'
}

/** The figures a row prints, a blank cell as null. */
function printedRow(table: string, label: string): Array<number | null> | undefined {
  for (const match of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (/<th>([^<]*)<\/th>/.exec(match[1])?.[1] !== label) continue
    return [...match[1].matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map((cell) => {
      const text = cell[1].replace(/<[^>]+>/g, '').replace(/\s/g, '')
      return text === '' ? null : Number(text.replace('−', '-'))
    })
  }
  return undefined
}

describe.each([
  ['K2', 'k2-ab-risbs-2024-09-12'],
  ['K3', 'k3-ab-risbs-2021-10-31'],
])('the equity table under the %s taxonomy', (_name, entryPointId) => {
  it('tags a fondemission out of the uppskrivningsfond with the concept both taxonomies spell without the l', () => {
    const { table, warnings } = render(entryPointId, [{ kind: 'fondemission', label: 'Fondemission' }], [
      post('Aktiekapital', 'Aktiekapital', 25_000, { fondemission: 50_000 }),
      post('Uppskrivningsfond', 'Uppskrivningsfond', 80_000, { fondemission: -50_000 }),
    ])
    expect(warnings).toEqual([])
    expect(facts(table, 'ForandringEgetKapitalAktiekapitalFondemission')).toEqual({ period0: '50000' })
    // "Minskning av uppskrivningsfond vid fondemission": a positive fact, shown with a minus.
    expect(facts(table, 'ForandringEgetKapitaUppskrivningsfondFondemission')).toEqual({ period0: '50000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitaUppskrivningsfondFondemission')).toBe(true)
    expect(table).not.toContain('ForandringEgetKapitalUppskrivningsfondFondemission')
    expect(facts(table, 'ForandringEgetKapitalTotaltFondemission')).toEqual({ period0: '0' })
    expect(printedRow(table, 'Fondemission')).toEqual([50_000, -50_000, 0])
  })

  it('tags an uppskrivning, and leaves a write-down against the fund untagged with a warning', () => {
    const kinds = [{ kind: 'uppskrivning', label: 'Uppskrivning' }]
    const up = render(entryPointId, kinds, [post('Uppskrivningsfond', 'Uppskrivningsfond', 0, { uppskrivning: 70_000 })])
    expect(up.warnings).toEqual([])
    expect(facts(up.table, 'ForandringEgetKapitalUppskrivningsfondUppskrivningAnlaggningstillgang')).toEqual({ period0: '70000' })
    expect(facts(up.table, 'ForandringEgetKapitalTotaltUppskrivningAnlaggningstillgang')).toEqual({ period0: '70000' })

    // "Ökning av uppskrivningsfond vid uppskrivning ...": a decrease is not that movement.
    const down = render(entryPointId, kinds, [post('Uppskrivningsfond', 'Uppskrivningsfond', 100_000, { uppskrivning: -30_000 })])
    expect(down.table).not.toContain('UppskrivningAnlaggningstillgang')
    expect(printedRow(down.table, 'Uppskrivning')).toEqual([-30_000, -30_000])
    expect(down.warnings).toEqual([
      'Förändringar i eget kapital: Uppskrivning (Uppskrivningsfond), Uppskrivning (totalt) har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.',
    ])
    // The balances of the post are facts either way.
    expect(facts(down.table, 'Uppskrivningsfond')).toEqual({ balans1: '100000', balans0: '70000' })
  })

  it('tags a decrease concept only for a decrease, and the total of a transfer only when it is zero', () => {
    const kinds = [
      { kind: 'resultatdisposition', label: 'Disposition' },
      { kind: 'utdelning', label: 'Utdelning' },
    ]
    const { table, warnings } = render(entryPointId, kinds, [
      // 30 001 in, 30 000 out: a krona of rounding on the transfer.
      post('BalanseratResultat', 'Balanserat resultat', 60_000, { resultatdisposition: 30_001, utdelning: 2_000 }),
      post('AretsResultatEgetKapital', 'Årets resultat', 40_000, { resultatdisposition: -30_000, utdelning: -10_000 }),
    ])
    // "Ökning (minskning) av ...": either way, signed.
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '30001' })
    expect(facts(table, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '-30000' })
    // "Förändring inom eget kapital ...": the krona is not a change within.
    expect(table).not.toContain('ForandringEgetKapitalTotaltBalanserasNyRakning')
    expect(printedRow(table, 'Disposition')).toEqual([30_001, -30_000, 1])
    // "Minskning av ... vid utdelning": the increase of 2 000 is not that movement.
    expect(table).not.toContain('ForandringEgetKapitalBalanseratResultatUtdelning')
    expect(facts(table, 'ForandringEgetKapitalAretsResultatUtdelning')).toEqual({ period0: '10000' })
    expect(shownAsDecrease(table, 'ForandringEgetKapitalAretsResultatUtdelning')).toBe(true)
    expect(facts(table, 'ForandringEgetKapitalTotaltUtdelning')).toEqual({ period0: '8000' })
    expect(printedRow(table, 'Utdelning')).toEqual([2_000, -10_000, -8_000])
    expect(warnings).toEqual([
      'Förändringar i eget kapital: Disposition (totalt), Utdelning (Balanserat resultat) har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.',
    ])
  })

  it('tags a loss year and a loss carried forward with signed facts', () => {
    const { table, warnings } = render(
      entryPointId,
      [
        { kind: 'resultatdisposition', label: 'Disposition' },
        { kind: 'arets_resultat', label: 'Årets resultat' },
      ],
      [
        post('BalanseratResultat', 'Balanserat resultat', 10_000, { resultatdisposition: -50_000 }),
        post('AretsResultatEgetKapital', 'Årets resultat', -50_000, { resultatdisposition: 50_000, arets_resultat: -70_000 }),
      ],
    )
    expect(warnings).toEqual([])
    expect(facts(table, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning')).toEqual({ period0: '-50000' })
    expect(facts(table, 'ForandringEgetKapitalAretsResultatBalanserasNyRakning')).toEqual({ period0: '50000' })
    expect(facts(table, 'ForandringEgetKapitalTotaltBalanserasNyRakning')).toEqual({ period0: '0' })
    expect(facts(table, 'ForandringEgetKapitalAretsResultatAretsResultat')).toEqual({ period0: '-70000' })
    expect(facts(table, 'EgetKapital')).toEqual({ balans1: '-40000', balans0: '-110000' })
  })
})

describe('the equity table on a sheet', () => {
  // A column per post: four posts and the total fill an A4 sheet at the
  // document's size, so from five the type shrinks in steps and the column
  // headings wrap. Seen in print with every post of each framework.
  const posts = (count: number) =>
    ['Aktiekapital', 'EjRegistreratAktiekapital', 'OverkursfondBunden', 'Uppskrivningsfond', 'Reservfond', 'FondUtvecklingsutgifter', 'Overkursfond', 'FondVerkligtVarde', 'BalanseratResultat', 'AretsResultatEgetKapital']
      .slice(0, count)
      .map((concept) => post(concept, concept, 10_000, {}))
  const tableTag = (count: number) => /^<table[^>]*>/.exec(render('k3-ab-risbs-2021-10-31', [], posts(count)).table)?.[0]

  it.each([
    [1, '<table class="ar-equity">'],
    [4, '<table class="ar-equity">'],
    [5, '<table class="ar-equity ar-cols-m">'],
    [6, '<table class="ar-equity ar-cols-m">'],
    [7, '<table class="ar-equity ar-cols-l">'],
    [8, '<table class="ar-equity ar-cols-l">'],
    [9, '<table class="ar-equity ar-cols-xl">'],
    [10, '<table class="ar-equity ar-cols-xl">'],
  ])('sets a table of %i posts as %s', (count, tag) => {
    expect(tableTag(count)).toBe(tag)
  })

  it('has a rule in the document\'s stylesheet for every class the table can carry', () => {
    expect(CSS).toContain('table.ar-equity th.num { white-space: normal; }')
    for (const size of ['ar-cols-m', 'ar-cols-l', 'ar-cols-xl']) {
      expect(CSS).toMatch(new RegExp(`table\\.${size} th, table\\.${size} td \\{ font-size: \\d+%; \\}`))
    }
  })
})

describe('the equity table under the K3 taxonomy only', () => {
  it('tags the effect of a correction at the year\'s start, where K3 has the concept and K2 has none', () => {
    const kinds = [{ kind: 'rattelse_av_fel', label: 'Effekt av rättelse av fel' }]
    const posts = [post('BalanseratResultat', 'Balanserat resultat', 60_000, { rattelse_av_fel: -4_000 })]
    const k3 = render('k3-ab-risbs-2021-10-31', kinds, posts)
    expect(k3.warnings).toEqual([])
    expect(facts(k3.table, 'ForandringEgetKapitalBalanseratResultatEffektRattelseFel')).toEqual({ balans1: '-4000' })
    expect(facts(k3.table, 'ForandringEgetKapitalTotaltEffektRattelseFel')).toEqual({ balans1: '-4000' })

    const k2 = render('k2-ab-risbs-2024-09-12', kinds, posts)
    expect(k2.table).not.toContain('EffektRattelseFel')
    expect(printedRow(k2.table, 'Effekt av rättelse av fel')).toEqual([-4_000, -4_000])
    expect(k2.warnings).toHaveLength(1)
  })
})
