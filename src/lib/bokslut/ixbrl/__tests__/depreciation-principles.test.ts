/**
 * The K2 "Avskrivningar" note in the iXBRL document: each row a tuple of
 * its balance sheet post's table of avskrivningsprinciper, which is
 * Bolagsverket's test criterion "minst en not som redovisas som en tuple i
 * XBRL" (Testunderlag för K2-årsredovisning 5.0, 2024-09-12).
 */
import { XMLValidator } from 'fast-xml-parser'
import { describe, expect, it } from 'vitest'
import { K2_FIXED_ASSET_NOTE_POSTS } from '@/lib/bokslut/arsredovisning/k2-fixed-asset-note'
import type { DepreciationPrinciple } from '@/lib/bokslut/arsredovisning/types'
import { depreciationPrincipleConcepts } from '../document/depreciation-principles'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { getRegistry } from '../taxonomy/registry'
import { makeInput } from './fixtures'

const registry = getRegistry('k2-ab-2024-09-12')

const BODY = [
  'Avskrivningar görs linjärt över bedömd nyttjandeperiod:',
  '• Byggnader: 50 år',
  '• Inventarier: 5 år',
  '• Datorer: 3 år',
  'Mark skrivs inte av.',
].join('\n')
const ROWS: DepreciationPrinciple[] = [
  { label: 'Byggnader', period: '50 år', post: 'ByggnaderMark' },
  { label: 'Inventarier', period: '5 år', post: 'InventarierVerktygInstallationer' },
  { label: 'Datorer', period: '3 år', post: 'InventarierVerktygInstallationer' },
]

function generate(rows: DepreciationPrinciple[] | undefined, body = BODY) {
  const input = makeInput()
  input.noter = [
    ...input.noter,
    { number: input.noter.length + 1, title: 'Avskrivningar', body, ...(rows ? { depreciationPrinciples: rows } : {}) },
  ]
  return generateK2IxbrlDocument(input)
}

/** Every tuple of the document: its concept, and its members in order with their values. */
function tuples(xhtml: string) {
  const declared = [...xhtml.matchAll(/<ix:tuple name="se-gaap-ext:(Avskrivningsprincip[A-Za-z]+)" tupleID="([^"]+)"\/>/g)]
  return declared.map(([, concept, id]) => ({
    concept,
    members: [...xhtml.matchAll(/<ix:nonNumeric ([^>]*)>([^<]*)<\/ix:nonNumeric>/g)]
      .filter(([, attributes]) => attributes.includes(`tupleRef="${id}"`))
      .map(([, attributes, value]) => ({
        name: /name="se-gen-base:([^"]+)"/.exec(attributes)?.[1],
        order: /order="([^"]+)"/.exec(attributes)?.[1],
        context: /contextRef="([^"]+)"/.exec(attributes)?.[1],
        value,
      })),
  }))
}

describe('depreciationPrincipleConcepts', () => {
  it('finds the table of every post whose assets are depreciated', () => {
    for (const post of K2_FIXED_ASSET_NOTE_POSTS) {
      const concepts = depreciationPrincipleConcepts(registry, post)
      expect(concepts, post).not.toBeNull()
      expect(registry.tuples[concepts!.tuple], post).toBeDefined()
      // The table is the post's own: its name ends with the post (byggnader och mark has the table of byggnader).
      expect(concepts!.tuple, post).toMatch(new RegExp(`Anlaggningstillgangar${post === 'ByggnaderMark' ? 'Byggnader' : post}Tuple$`))
      expect(registry.concepts[concepts!.name]?.dataType, post).toBe('xbrli:stringItemType')
      expect(registry.concepts[concepts!.period]?.dataType, post).toBe('xbrli:stringItemType')
    }
  })

  it('uses every table of avskrivningsprinciper the taxonomy has', () => {
    const used = new Set(K2_FIXED_ASSET_NOTE_POSTS.map((post) => depreciationPrincipleConcepts(registry, post)!.tuple))
    const inTaxonomy = Object.keys(registry.tuples).filter((name) => name.startsWith('Avskrivningsprincip'))
    expect(inTaxonomy.filter((name) => !used.has(name))).toEqual([])
  })

  it('has no table for a post outside the fixed assets, or for no post', () => {
    expect(depreciationPrincipleConcepts(registry, 'Kundfordringar')).toBeNull()
    expect(depreciationPrincipleConcepts(registry, null)).toBeNull()
  })
})

describe('the Avskrivningar note in the K2 document', () => {
  it('tags each row as a tuple of its post, with both members where they are read', () => {
    const { xhtml, warnings } = generate(ROWS)
    expect(XMLValidator.validate(xhtml)).toBe(true)
    expect(warnings).toEqual(makeInput().warnings)
    expect(tuples(xhtml)).toEqual([
      {
        concept: 'AvskrivningsprincipMateriellaAnlaggningstillgangarByggnaderTuple',
        members: [
          { name: 'AvskrivningsprincipMateriellAnlaggningstillgangBenamning', order: '1.0', context: 'period0', value: 'Byggnader' },
          { name: 'AvskrivningsprincipMateriellAnlaggningstillgangNyttjandeperiod', order: '3.0', context: 'period0', value: '50 år' },
        ],
      },
      {
        concept: 'AvskrivningsprincipMateriellaAnlaggningstillgangarInventarierVerktygInstallationerTuple',
        members: [
          { name: 'AvskrivningsprincipMateriellAnlaggningstillgangBenamning', order: '1.0', context: 'period0', value: 'Inventarier' },
          { name: 'AvskrivningsprincipMateriellAnlaggningstillgangNyttjandeperiod', order: '3.0', context: 'period0', value: '5 år' },
        ],
      },
      // Two kinds of asset in one post: two tuples of the same table.
      {
        concept: 'AvskrivningsprincipMateriellaAnlaggningstillgangarInventarierVerktygInstallationerTuple',
        members: [
          { name: 'AvskrivningsprincipMateriellAnlaggningstillgangBenamning', order: '1.0', context: 'period0', value: 'Datorer' },
          { name: 'AvskrivningsprincipMateriellAnlaggningstillgangNyttjandeperiod', order: '3.0', context: 'period0', value: '3 år' },
        ],
      },
    ])
  })

  it('gives every tuple an id of its own', () => {
    const ids = [...generate(ROWS).xhtml.matchAll(/tupleID="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('prints the text around the table once, and each row once', () => {
    const { xhtml } = generate(ROWS)
    expect(xhtml.match(/Avskrivningar görs linjärt över bedömd nyttjandeperiod:/g)).toHaveLength(1)
    expect(xhtml.match(/Mark skrivs inte av\./g)).toHaveLength(1)
    expect(xhtml).not.toContain('• Inventarier')
    const note = xhtml.slice(xhtml.indexOf('Avskrivningar görs linjärt'))
    expect(note.indexOf('<table class="ar-depreciation">')).toBeLessThan(note.indexOf('Mark skrivs inte av.'))
  })

  it('tags an immaterial asset with the immateriella members', () => {
    const { xhtml } = generate([{ label: 'Immateriella anläggningstillgångar', period: '5 år', post: 'Goodwill' }], '• Immateriella anläggningstillgångar: 5 år')
    expect(tuples(xhtml)).toEqual([
      {
        concept: 'AvskrivningsprincipImmateriellaAnlaggningstillgangarGoodwillTuple',
        members: [
          { name: 'AvskrivningsprincipImmateriellAnlaggningstillgangBenamning', order: '1.0', context: 'period0', value: 'Immateriella anläggningstillgångar' },
          { name: 'AvskrivningsprincipImmateriellAnlaggningstillgangNyttjandeperiod', order: '3.0', context: 'period0', value: '5 år' },
        ],
      },
    ])
  })

  it('prints a row whose assets are on no post untagged', () => {
    const { xhtml } = generate([{ label: 'Inventarier', period: '5 år', post: null }], '• Inventarier: 5 år')
    expect(tuples(xhtml)).toEqual([])
    expect(xhtml).toContain('<td>Inventarier</td>')
    expect(xhtml).toContain('<td class="num">5 år</td>')
  })

  it('prints the table also when the text holds no row line to put it at', () => {
    const { xhtml } = generate(ROWS, 'Avskrivningar görs linjärt över bedömd nyttjandeperiod.')
    expect(tuples(xhtml)).toHaveLength(3)
    const text = xhtml.indexOf('Avskrivningar görs linjärt över bedömd nyttjandeperiod.')
    expect(text).toBeGreaterThan(0)
    expect(text).toBeLessThan(xhtml.indexOf('>Byggnader<'))
    expect(XMLValidator.validate(xhtml)).toBe(true)
  })

  it('prints the text of a note stored before the rows existed', () => {
    const { xhtml } = generate(undefined)
    expect(tuples(xhtml)).toEqual([])
    expect(xhtml).toContain('• Inventarier: 5 år')
  })
})
