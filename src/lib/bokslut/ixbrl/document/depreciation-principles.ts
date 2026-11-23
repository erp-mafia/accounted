/**
 * The K2 "Avskrivningar" note in the iXBRL document: each row (a kind of
 * asset and the period it is depreciated over) is a tuple of the taxonomy's
 * table of avskrivningsprinciper for the balance sheet post the assets are
 * booked on, as in Bolagsverket's example document 1 (se-gaap-ext
 * `Avskrivningsprincip…Tuple` with the members Benämning and
 * Nyttjandeperiod). A tuple is how the taxonomy lets one concept repeat: two
 * kinds of asset in one post are two tuples of the same table.
 *
 * Both members are tagged where they are read. The text around the table
 * (the introduction, that mark is not depreciated) is the note's own text.
 */
import {
  isDepreciationPrincipleRow,
} from '@/lib/bokslut/arsredovisning/anlaggningstillgangar-note'
import type { DepreciationPrinciple } from '@/lib/bokslut/arsredovisning/types'
import type { TaxonomyRegistry } from '../taxonomy/registry'
import type { FactWriter } from './ix'
import { el, escapeText } from './xml'

/**
 * The table of avskrivningsprinciper of each balance sheet post that holds
 * depreciable assets, after the taxonomy's prefix. Byggnader och mark has
 * the table "Byggnader": mark is not depreciated.
 */
const TABLE_OF_POST: Record<string, { kind: 'Immateriell' | 'Materiell'; table: string }> = {
  KoncessionerPatentLicenserVarumarkenLiknandeRattigheter: {
    kind: 'Immateriell',
    table: 'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter',
  },
  HyresratterLiknandeRattigheter: { kind: 'Immateriell', table: 'HyresratterLiknandeRattigheter' },
  Goodwill: { kind: 'Immateriell', table: 'Goodwill' },
  ByggnaderMark: { kind: 'Materiell', table: 'Byggnader' },
  MaskinerAndraTekniskaAnlaggningar: { kind: 'Materiell', table: 'MaskinerAndraTekniskaAnlaggningar' },
  InventarierVerktygInstallationer: { kind: 'Materiell', table: 'InventarierVerktygInstallationer' },
  ForbattringsutgifterAnnansFastighet: { kind: 'Materiell', table: 'ForbattringsutgifterAnnansFastighet' },
  OvrigaMateriellaAnlaggningstillgangar: { kind: 'Materiell', table: 'OvrigaMateriellaAnlaggningstillgangar' },
}

/** The tuple and its two members for a post, or null when the taxonomy has no table for it. */
export function depreciationPrincipleConcepts(
  registry: TaxonomyRegistry,
  post: string | null,
): { tuple: string; name: string; period: string } | null {
  const entry = post ? TABLE_OF_POST[post] : undefined
  if (!entry) return null
  const tuple = `Avskrivningsprincip${entry.kind}aAnlaggningstillgangar${entry.table}Tuple`
  const name = `Avskrivningsprincip${entry.kind}AnlaggningstillgangBenamning`
  const period = `Avskrivningsprincip${entry.kind}AnlaggningstillgangNyttjandeperiod`
  const members = registry.tuples[tuple]?.members.map((member) => member.name) ?? []
  return members.includes(name) && members.includes(period) ? { tuple, name, period } : null
}

/**
 * The note: its text lines as paragraphs, and its rows as one table where
 * the first row stood. A row whose post has no table in the taxonomy prints
 * untagged.
 */
export function renderDepreciationPrinciples(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  body: string,
  rows: readonly DepreciationPrinciple[],
): string {
  const declarations: string[] = []
  const tableRows = rows.map((row) => {
    const concepts = depreciationPrincipleConcepts(registry, row.post)
    if (!concepts) {
      return el('tr', {}, el('td', {}, escapeText(row.label)) + el('td', { class: 'num' }, escapeText(row.period)))
    }
    const members = registry.tuples[concepts.tuple].members
    const orderOf = (member: string) => `${members.findIndex((m) => m.name === member) + 1}.0`
    const tupleId = writer.declareTupleId(concepts.tuple)
    declarations.push(writer.tupleDeclaration(concepts.tuple, tupleId))
    return el(
      'tr',
      {},
      el('td', {}, writer.textPlain(concepts.name, 'period0', row.label, { tupleRef: tupleId, order: orderOf(concepts.name) })) +
        el(
          'td',
          { class: 'num' },
          writer.textPlain(concepts.period, 'period0', row.period, { tupleRef: tupleId, order: orderOf(concepts.period) }),
        ),
    )
  })
  const table = declarations.join('') + el('table', { class: 'ar-depreciation' }, tableRows.join(''))

  const parts: string[] = []
  let tablePrinted = false
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue
    if (!isDepreciationPrincipleRow(line)) {
      parts.push(el('p', {}, escapeText(line)))
    } else if (!tablePrinted) {
      parts.push(table)
      tablePrinted = true
    }
  }
  if (!tablePrinted) parts.push(table)
  return parts.join('\n')
}
