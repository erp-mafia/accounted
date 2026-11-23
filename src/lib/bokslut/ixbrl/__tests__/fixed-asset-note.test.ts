/**
 * The K2 note on anläggningstillgångar in the iXBRL document. The last
 * suite is Bolagsverket's own criterion for a complete note (Testunderlag
 * för K2-årsredovisning 5.0, 2024-09-12): every concept of the post's
 * family is tagged and holds a value other than zero.
 */
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import type { AnlaggningAsset } from '@/lib/bokslut/arsredovisning/anlaggningstillgangar-note'
import {
  fixedAssetNoteBody,
  fixedAssetOpeningCarrying,
  FIXED_ASSET_STATED_ROWS,
  K2_FIXED_ASSET_NOTE_POSTS,
  type FixedAssetNoteTable,
} from '@/lib/bokslut/arsredovisning/k2-fixed-asset-note'
import { fixedAssetNoteConcept } from '../document/fixed-asset-note'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { getRegistry } from '../taxonomy/registry'
import {
  COMPLETE_NOTE_BOOKS,
  COMPLETE_NOTE_POST,
  COMPLETE_NOTE_STATED_ROWS,
  completeFixedAssetTables,
  fixedAssetTables,
  makeCompleteFixedAssetNoteInput,
  makeInput,
} from './fixtures'

const registry = getRegistry('k2-ab-2024-09-12')

const tablesFor = fixedAssetTables

function generate(tables: FixedAssetNoteTable[], patch: (input: ReturnType<typeof makeInput>) => void = () => {}) {
  const input = makeInput()
  input.noter = [
    ...input.noter,
    { number: input.noter.length + 1, title: 'Anläggningstillgångar', body: fixedAssetNoteBody(tables), fixedAssets: tables },
  ]
  for (const table of tables) {
    // No jämförelsetal for the post: a zero there would be a tagged zero of the concept.
    if (table.post) input.br[table.post] = { current: Math.round(table.carrying), previous: null }
  }
  patch(input)
  return generateK2IxbrlDocument(input)
}

/** Every fact of a concept: its context, sign attribute, value and whether a minus precedes it. */
function facts(xhtml: string, concept: string) {
  const pattern = new RegExp(`(−?)<ix:nonFraction ([^>]*name="se-gen-base:${concept}"[^>]*)>([^<]*)</ix:nonFraction>`, 'g')
  return [...xhtml.matchAll(pattern)].map((match) => ({
    minus: match[1] === '−',
    context: /contextRef="([^"]+)"/.exec(match[2])?.[1],
    negative: /sign="-"/.test(match[2]),
    value: Number(match[3].replace(/\s/g, '')),
  }))
}

const BUILDING: AnlaggningAsset = {
  category: 'building',
  acquisition_date: '2020-01-01',
  acquisition_cost: 2_000_000,
  salvage_value: 0,
  useful_life_months: 600,
  disposed_at: null,
  bas_asset_account: '1110',
  figures: { ibAck: 200_000, aretsAvskrivning: 40_000, avgaendeAck: 0 },
  writeDowns: { opening: 80_000, writtenDown: 30_000, reversed: 10_000, disposed: 0, closing: 100_000 },
}
describe('fixedAssetNoteConcept', () => {
  const blockOf = (key: string) => key.split('.')[0] as 'cost' | 'depreciation' | 'impairment'
  const MOVEMENTS = [
    'cost.inkop', 'cost.rorelseforvarv', 'cost.fusion', 'cost.forsaljningar', 'cost.omklassificeringar', 'cost.omrakningsdifferenser',
    'depreciation.fusion', 'depreciation.forsaljningar', 'depreciation.omklassificeringar', 'depreciation.arets', 'depreciation.omrakningsdifferenser',
    'impairment.fusion', 'impairment.forsaljningar', 'impairment.aterforda', 'impairment.omklassificeringar', 'impairment.arets', 'impairment.omrakningsdifferenser',
  ]

  it('resolves every row of every post the taxonomy gives a note', () => {
    const unresolved: string[] = []
    for (const post of K2_FIXED_ASSET_NOTE_POSTS) {
      for (const key of MOVEMENTS) {
        // Goodwill has no Inköp concept: the register's purchases print as rörelseförvärv.
        const expected = key === 'cost.inkop' && post === 'Goodwill' ? null : 'a concept'
        const concept = fixedAssetNoteConcept(registry, post, blockOf(key), { key, kind: 'movement' })
        if ((concept === null) !== (expected === null)) unresolved.push(`${post} ${key} -> ${concept}`)
      }
      for (const block of ['cost', 'depreciation', 'impairment'] as const) {
        if (!fixedAssetNoteConcept(registry, post, block, { key: `${block}.opening`, kind: 'opening' })) {
          unresolved.push(`${post} ${block} balance`)
        }
      }
    }
    expect(unresolved).toEqual([])
  })

  it('uses every concept of a post family but the uppskrivningar, which the note does not hold', () => {
    const used = new Set<string>()
    for (const post of K2_FIXED_ASSET_NOTE_POSTS) {
      used.add(post)
      for (const key of MOVEMENTS) {
        const concept = fixedAssetNoteConcept(registry, post, blockOf(key), { key, kind: 'movement' })
        if (concept) used.add(concept)
      }
      for (const block of ['cost', 'depreciation', 'impairment'] as const) {
        const concept = fixedAssetNoteConcept(registry, post, block, { key: `${block}.closing`, kind: 'closing' })
        if (concept) used.add(concept)
      }
    }
    const family = Object.entries(registry.concepts)
      .filter(([name, concept]) =>
        K2_FIXED_ASSET_NOTE_POSTS.some((post) => name.startsWith(post)) &&
        !concept.abstract &&
        concept.dataType === 'xbrli:monetaryItemType' &&
        /(Forandring(Anskaffningsvarden|Avskrivningar|Uppskrivningar|Nedskrivningar)|Anskaffningsvarden$|Avskrivningar$|Uppskrivningar$|Nedskrivningar$)/.test(name),
      )
      .map(([name]) => name)
    const unused = family.filter((name) => !used.has(name))
    // K2 allows an uppskrivning of byggnader och mark only, and the note does
    // not hold them: the balance and its six movements are the ones left.
    expect(unused.every((name) => name.startsWith('ByggnaderMark') && name.includes('Uppskrivningar'))).toBe(true)
    expect(unused).toHaveLength(7)
  })

  it("gives each row the direction of its concept's standard label", () => {
    // The direction a positive value has, read from the label the taxonomy
    // gives the concept; the tables must roll forward the same way.
    const direction = (label: string): 1 | -1 | null => {
      if (/^Ökning/.test(label) || /^Periodens (avskrivningar|nedskrivningar)/.test(label)) return 1
      if (/^Minskning/.test(label) || /^(Periodens återförda|Återförda)/.test(label)) return -1
      return null
    }
    const tables = completeFixedAssetTables()
    const mismatches: string[] = []
    let checked = 0
    for (const block of tables[0].blocks) {
      for (const row of block.rows.filter((r) => r.kind === 'movement')) {
        const concept = fixedAssetNoteConcept(registry, COMPLETE_NOTE_POST, block.key, row)
        const label = concept ? registry.concepts[concept].label : ''
        if (direction(label) !== row.effect) mismatches.push(`${row.key}: ${label}`)
        checked += 1
      }
    }
    expect(mismatches).toEqual([])
    expect(checked).toBe(MOVEMENTS.length)
  })

  it('has a concept in every post for each row a user can state', () => {
    for (const row of FIXED_ASSET_STATED_ROWS) {
      for (const post of K2_FIXED_ASSET_NOTE_POSTS) {
        const concept = fixedAssetNoteConcept(registry, post, blockOf(row), { key: row, kind: 'movement' })
        expect(concept, `${post} ${row}`).not.toBeNull()
      }
    }
  })

  it('prints the taxonomy\'s own row label on every row, so no changed label needs logging (Tillämpningsanvisning 2.20)', () => {
    // The element list's "Radrubrik" of the rows of a post's note. Pinned
    // here because the registry carries the standard label only.
    const RADRUBRIKER: Record<string, string> = {
      'cost.opening': 'Ingående anskaffningsvärden',
      'cost.inkop': 'Inköp',
      'cost.rorelseforvarv': 'Rörelseförvärv',
      'cost.fusion': 'Fusion',
      'cost.forsaljningar': 'Försäljningar/utrangeringar',
      'cost.omklassificeringar': 'Omklassificeringar',
      'cost.omrakningsdifferenser': 'Omräkningsdifferenser',
      'cost.closing': 'Utgående anskaffningsvärden',
      'depreciation.opening': 'Ingående avskrivningar',
      'depreciation.fusion': 'Fusion',
      'depreciation.forsaljningar': 'Försäljningar/utrangeringar',
      'depreciation.omklassificeringar': 'Omklassificeringar',
      'depreciation.arets': 'Årets avskrivningar',
      'depreciation.omrakningsdifferenser': 'Omräkningsdifferenser',
      'depreciation.closing': 'Utgående avskrivningar',
      'impairment.opening': 'Ingående nedskrivningar',
      'impairment.fusion': 'Fusion',
      'impairment.forsaljningar': 'Försäljningar/utrangeringar',
      'impairment.aterforda': 'Återförda nedskrivningar',
      'impairment.omklassificeringar': 'Omklassificeringar',
      'impairment.arets': 'Årets nedskrivningar',
      'impairment.omrakningsdifferenser': 'Omräkningsdifferenser',
      'impairment.closing': 'Utgående nedskrivningar',
    }
    const printed = Object.fromEntries(
      completeFixedAssetTables()[0].blocks.flatMap((block) => block.rows.map((row) => [row.key, row.label])),
    )
    expect(printed).toEqual(RADRUBRIKER)
  })
})

describe('the note in the K2 document', () => {
  it('tags the register rows as Bolagsverket\'s example does', () => {
    const tables = tablesFor([
      { ...BUILDING, category: 'equipment', bas_asset_account: '1220', acquisition_cost: 60_000, figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 }, writeDowns: undefined },
    ])
    const { xhtml, warnings } = generate(tables)
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(warnings).toEqual(makeInput().warnings)
    const post = 'InventarierVerktygInstallationer'
    expect(facts(xhtml, `${post}Anskaffningsvarden`)).toEqual([
      { minus: false, context: 'balans1', negative: false, value: 60_000 },
      { minus: false, context: 'balans0', negative: false, value: 60_000 },
    ])
    // Accumulated avskrivningar are positive values printed with a minus.
    expect(facts(xhtml, `${post}Avskrivningar`)).toEqual([
      { minus: true, context: 'balans1', negative: false, value: 12_000 },
      { minus: true, context: 'balans0', negative: false, value: 24_000 },
    ])
    expect(facts(xhtml, `${post}ForandringAvskrivningarAretsAvskrivningar`)).toEqual([
      { minus: true, context: 'period0', negative: false, value: 12_000 },
    ])
    // The redovisat värde repeats the balance sheet post, value for value.
    expect(facts(xhtml, post).filter((fact) => fact.context === 'balans0').map((fact) => fact.value)).toEqual([36_000, 36_000])
    expect(xhtml).toContain('<h4>Inventarier, verktyg och installationer</h4>')
  })

  it('leaves the redovisat värde untagged and says so when the note does not tie to its post', () => {
    const tables = tablesFor([BUILDING])
    const { xhtml, warnings } = generate(tables, (input) => {
      input.br.ByggnaderMark = { current: 1_500_000, previous: 0 }
    })
    expect(facts(xhtml, 'ByggnaderMark').filter((fact) => fact.context === 'balans0')).toHaveLength(1)
    expect(warnings.some((warning) => warning.includes('Byggnader och mark') && warning.includes('inte taggat'))).toBe(true)
  })

  it('tags the redovisat värde only when it is the post to the krona', () => {
    const tables = tablesFor([BUILDING])
    const carrying = Math.round(tables[0].carrying)
    const { xhtml, warnings } = generate(tables, (input) => {
      input.br.ByggnaderMark = { current: carrying + 1, previous: null }
    })
    // The balance sheet's own fact only: the note prints its figure untagged.
    expect(facts(xhtml, 'ByggnaderMark').map((fact) => fact.value)).toEqual([carrying + 1])
    expect(warnings.some((warning) => warning.includes('inte taggat'))).toBe(true)
  })

  it('prints a tagged zero without a minus', () => {
    // Bought this year: no avskrivningar at the start of it.
    const tables = tablesFor([
      { ...BUILDING, acquisition_date: '2025-03-01', figures: { ibAck: 0, aretsAvskrivning: 30_000, avgaendeAck: 0 }, writeDowns: undefined },
    ])
    const { xhtml } = generate(tables)
    expect(facts(xhtml, 'ByggnaderMarkAvskrivningar')).toEqual([
      { minus: false, context: 'balans1', negative: false, value: 0 },
      { minus: true, context: 'balans0', negative: false, value: 30_000 },
    ])
  })

  it('declares the day before the year for the opening balances of a document without a jämförelseår', () => {
    const tables = tablesFor([BUILDING])
    const { xhtml } = generate(tables, (input) => {
      input.previousPeriod = null
      input.forvaltningsberattelse.flerarsoversikt = input.forvaltningsberattelse.flerarsoversikt.slice(0, 1)
      input.forvaltningsberattelse.flerarsPerioder = input.forvaltningsberattelse.flerarsPerioder.slice(0, 1)
      for (const amounts of [input.rr, input.br]) {
        for (const amount of Object.values(amounts)) amount.previous = null
      }
    })
    expect(xhtml).toMatch(/<xbrli:context id="balans1">[\s\S]*?<xbrli:instant>2024-12-31<\/xbrli:instant>/)
    expect(facts(xhtml, 'ByggnaderMarkAnskaffningsvarden')[0]).toMatchObject({ context: 'balans1', value: 2_000_000 })
  })

  it('prints the text body of a note stored before the tables existed', () => {
    const input = makeInput()
    input.noter = [...input.noter, { number: 7, title: 'Anläggningstillgångar', body: 'Inventarier\n  Utgående redovisat värde: 36 000 kr' }]
    const { xhtml } = generateK2IxbrlDocument(input)
    expect(xhtml).toContain('Utgående redovisat värde: 36 000 kr')
    expect(xhtml).not.toContain('InventarierVerktygInstallationerAnskaffningsvarden')
  })
})

describe('a complete note (Bolagsverket test criterion)', () => {
  // The machines are on the books as written out in COMPLETE_NOTE_BOOKS, so
  // the note's redovisat värde is its balance sheet post.
  const { xhtml, warnings } = generateK2IxbrlDocument(makeCompleteFixedAssetNoteInput())
  const concept = (suffix: string) => `${COMPLETE_NOTE_POST}${suffix}`
  const table = () => completeFixedAssetTables()[0]
  const rows = () => Object.fromEntries(table().blocks.flatMap((block) => block.rows.map((row) => [row.key, row.amount])))

  it('rolls each block forward to the balance the books hold', () => {
    const { opening, closing } = COMPLETE_NOTE_BOOKS
    expect([rows()['cost.opening'], rows()['depreciation.opening'], rows()['impairment.opening']]).toEqual([
      opening.cost,
      opening.depreciation,
      opening.impairment,
    ])
    expect([rows()['cost.closing'], rows()['depreciation.closing'], rows()['impairment.closing']]).toEqual([
      closing.cost,
      closing.depreciation,
      closing.impairment,
    ])
    expect(fixedAssetOpeningCarrying(table())).toBe(opening.cost - opening.depreciation - opening.impairment)
    expect(table().carrying).toBe(closing.cost - closing.depreciation - closing.impairment)
  })

  it('ties to the balance sheet: the redovisat värde is tagged with the post, and nothing is warned', () => {
    const { closing } = COMPLETE_NOTE_BOOKS
    const carrying = closing.cost - closing.depreciation - closing.impairment
    expect(facts(xhtml, COMPLETE_NOTE_POST).filter((fact) => fact.context === 'balans0').map((fact) => fact.value)).toEqual([carrying, carrying])
    expect(warnings).toEqual(makeInput().warnings)
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('states every row a user can state', () => {
    expect(Object.keys(COMPLETE_NOTE_STATED_ROWS[COMPLETE_NOTE_POST] ?? {}).sort()).toEqual([...FIXED_ASSET_STATED_ROWS].sort())
  })

  it('tags every concept of the post with a value other than zero', () => {
    const family = Object.entries(registry.concepts)
      .filter(([name, entry]) => name.startsWith(COMPLETE_NOTE_POST) && !entry.abstract && entry.dataType === 'xbrli:monetaryItemType')
      .map(([name]) => name)
    // The post, three balances and seventeen movements.
    expect(family).toHaveLength(21)
    const empty = family.filter((name) => {
      const tagged = facts(xhtml, name)
      return tagged.length === 0 || tagged.some((fact) => fact.value === 0)
    })
    expect(empty).toEqual([])
  })

  it('tags each balance at the previous balance sheet date and at year end', () => {
    for (const suffix of ['Anskaffningsvarden', 'Avskrivningar', 'Nedskrivningar']) {
      expect(facts(xhtml, concept(suffix)).map((fact) => fact.context)).toEqual(['balans1', 'balans0'])
    }
  })

  it('puts a value that runs against its standard label in the sign attribute, never in the text', () => {
    // Omräkningsdifferenser of the anskaffningsvärden were stated as a
    // decrease (-8 000): "Ökning (minskning)" makes that sign="-".
    expect(facts(xhtml, concept('ForandringAnskaffningsvardenOmrakningsdifferenser'))).toEqual([
      { minus: true, context: 'period0', negative: true, value: 8_000 },
    ])
    // The avskrivningar that came in with the reclassified machine raise the
    // accumulated amount: "Minskning (ökning)" makes that -5 000, printed as
    // a reduction of the redovisat värde.
    expect(facts(xhtml, concept('ForandringAvskrivningarOmklassificeringar'))).toEqual([
      { minus: true, context: 'period0', negative: true, value: 5_000 },
    ])
    // Försäljningar: a positive "Minskning", printed with a minus.
    expect(facts(xhtml, concept('ForandringAnskaffningsvardenForsaljningarUtrangeringar'))).toEqual([
      { minus: true, context: 'period0', negative: false, value: 400_000 },
    ])
    // Avskrivningar brought back by the sale: positive, no minus.
    expect(facts(xhtml, concept('ForandringAvskrivningarAterfordaAvskrivningarForsaljningarRespUtrangeringar'))).toEqual([
      { minus: false, context: 'period0', negative: false, value: 66_000 },
    ])
    // Nedskrivningar taken over in the fusion raise the accumulated amount:
    // positive, printed with a minus.
    expect(facts(xhtml, concept('ForandringNedskrivningarFusion'))).toEqual([
      { minus: true, context: 'period0', negative: false, value: 11_000 },
    ])
    // Nedskrivningar that left with the machines sold: the register's
    // 20 000 and the 4 000 stated for the write-down accounts beyond it.
    expect(facts(xhtml, concept('ForandringNedskrivningarAterfordaNedskrivningarForsaljningarRespUtrangeringar'))).toEqual([
      { minus: false, context: 'period0', negative: false, value: 24_000 },
    ])
  })

  it('puts each machine that came in on the row of how it was acquired', () => {
    expect(facts(xhtml, concept('ForandringAnskaffningsvardenInkop'))[0].value).toBe(900_000)
    expect(facts(xhtml, concept('ForandringAnskaffningsvardenRorelseforvarv'))[0].value).toBe(150_000)
    expect(facts(xhtml, concept('ForandringAnskaffningsvardenFusion'))[0].value).toBe(250_000)
    expect(facts(xhtml, concept('ForandringAnskaffningsvardenOmklassificeringar'))[0].value).toBe(70_000)
    expect(facts(xhtml, concept('ForandringAvskrivningarFusion'))[0].value).toBe(45_000)
  })
})

describe('the PDF text and the tagged table round alike', () => {
  it('prints a negative amount that ends in 50 öre as the same whole kronor in both', () => {
    // 5 000,50 kr of avskrivningar came in with a reclassified asset.
    const tables = tablesFor([
      {
        ...BUILDING,
        category: 'equipment',
        bas_asset_account: '1220',
        acquisition_date: '2025-05-01',
        acquisition_type: 'reclassification',
        acquisition_cost: 20_000,
        figures: { ibAck: 5_000.5, aretsAvskrivning: 0, avgaendeAck: 0 },
        writeDowns: undefined,
      },
    ])
    expect(fixedAssetNoteBody(tables)).toMatch(/Omklassificeringar: -5\s001 kr/)
    const { xhtml } = generate(tables)
    expect(facts(xhtml, 'InventarierVerktygInstallationerForandringAvskrivningarOmklassificeringar')).toEqual([
      { minus: true, context: 'period0', negative: true, value: 5_001 },
    ])
  })
})
