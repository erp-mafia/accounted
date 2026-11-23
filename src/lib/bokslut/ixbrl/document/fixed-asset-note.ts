/**
 * The K2 note on anläggningstillgångar in the iXBRL document: one table per
 * balance sheet post with every figure tagged, as Bolagsverket's example
 * documents and test criteria show it (se-gen-base, taxonomy version
 * 2024-09-12). Information of weight for the document is tagged
 * (Tillämpningsanvisning 2.3.1).
 *
 * The rows come from arsredovisning/k2-fixed-asset-note.ts, the same rows
 * the PDF prints as text. Each row key maps to a concept of the post's
 * family:
 *   - the balance of a block (opening and closing) is one instant concept
 *     (`<Post>Anskaffningsvarden`, `…Avskrivningar`, `…Nedskrivningar`), at
 *     the previous balance sheet date (context balans1, TA 2.16.7) and at
 *     year end. Opening and closing share the concept, as in taxonomier.se's
 *     tagging example 9;
 *   - a movement is a duration concept of the year
 *     (`<Post>ForandringAnskaffningsvardenInkop`, …);
 *   - the redovisat värde is the balance sheet post itself: the same data in
 *     a second place, which is tagged there too (TA 2.7.2) with the
 *     identical value (TA 2.7.1).
 *
 * A value is positive in the direction its standard label names; a value
 * against that direction carries the sign attribute (TA 2.10.6). A figure
 * that reduces the redovisat värde prints with a minus outside the fact, as
 * taxonomier.se's tagging example 7 and Bolagsverket's example documents
 * show it. A row whose concept the registry does not hold prints untagged.
 */
import type {
  FixedAssetNoteBlock,
  FixedAssetNoteRow,
  FixedAssetNoteTable,
} from '@/lib/bokslut/arsredovisning/k2-fixed-asset-note'
import { FIXED_ASSET_CARRYING_LABEL } from '@/lib/bokslut/arsredovisning/k2-fixed-asset-note'
import { addDaysIso } from '@/lib/dates/iso'
import { roundWhole as wholeKronor } from '../whole-kronor'
import { getConcept, type TaxonomyRegistry } from '../taxonomy/registry'
import type { IxbrlArsredovisningInput } from '../types'
import type { FactWriter } from './ix'
import { el, escapeText, formatSekAbs } from './xml'

/** The instant concept of each block's balance, after the post's name. */
const BALANCE_SUFFIX: Record<FixedAssetNoteBlock['key'], string> = {
  cost: 'Anskaffningsvarden',
  depreciation: 'Avskrivningar',
  impairment: 'Nedskrivningar',
}

/**
 * The movement concepts after the post's name. Two rows are spelled
 * differently in a few families of the taxonomy: the first name the
 * registry holds wins.
 */
const MOVEMENT_SUFFIXES: Record<string, readonly string[]> = {
  'cost.inkop': ['ForandringAnskaffningsvardenInkop'],
  'cost.rorelseforvarv': ['ForandringAnskaffningsvardenRorelseforvarv'],
  'cost.fusion': ['ForandringAnskaffningsvardenFusion'],
  'cost.forsaljningar': ['ForandringAnskaffningsvardenForsaljningarUtrangeringar'],
  'cost.omklassificeringar': ['ForandringAnskaffningsvardenOmklassificeringar'],
  'cost.omrakningsdifferenser': ['ForandringAnskaffningsvardenOmrakningsdifferenser'],
  'depreciation.fusion': ['ForandringAvskrivningarFusion', 'ForandringAvskrivningarAterfordaAvskrivningarFusion'],
  'depreciation.forsaljningar': ['ForandringAvskrivningarAterfordaAvskrivningarForsaljningarRespUtrangeringar'],
  'depreciation.omklassificeringar': ['ForandringAvskrivningarOmklassificeringar'],
  'depreciation.arets': ['ForandringAvskrivningarAretsAvskrivningar'],
  'depreciation.omrakningsdifferenser': ['ForandringAvskrivningarOmrakningsdifferenser'],
  'impairment.fusion': ['ForandringNedskrivningarFusion'],
  'impairment.forsaljningar': [
    'ForandringNedskrivningarAterfordaNedskrivningarForsaljningarRespUtrangeringar',
    'ForandringNedskrivningarAterfordaNedskrivningarPaForsaljningarRespUtrangeringar',
  ],
  'impairment.aterforda': ['ForandringNedskrivningarAterfordaNedskrivningar'],
  'impairment.omklassificeringar': ['ForandringNedskrivningarOmklassificeringar'],
  'impairment.arets': ['ForandringNedskrivningarAretsNedskrivningar'],
  'impairment.omrakningsdifferenser': ['ForandringNedskrivningarOmrakningsdifferenser'],
}

/**
 * The concept a row of a post's table is tagged with, null when the
 * taxonomy has none (the row then prints untagged).
 */
export function fixedAssetNoteConcept(
  registry: TaxonomyRegistry,
  post: string | null,
  block: FixedAssetNoteBlock['key'],
  row: Pick<FixedAssetNoteRow, 'key' | 'kind'>,
): string | null {
  if (!post) return null
  const names =
    row.kind === 'movement'
      ? (MOVEMENT_SUFFIXES[row.key] ?? []).map((suffix) => `${post}${suffix}`)
      : [`${post}${BALANCE_SUFFIX[block]}`]
  return names.find((name) => getConcept(registry, name)?.dataType === 'xbrli:monetaryItemType') ?? null
}

function plainAmount(value: number, displayMinus: boolean): string {
  const rounded = wholeKronor(value)
  const text = escapeText(formatSekAbs(rounded))
  return displayMinus !== rounded < 0 && rounded !== 0 ? `−${text}` : text
}

/**
 * The tables of the note, one column for the year (K2 punkt 3.10 asks for no
 * jämförelsetal in notes). The opening balances sit at the previous balance
 * sheet date (context balans1, declared here when the document has no
 * jämförelseår); a first year without opening balances prints them untagged.
 */
export function renderFixedAssetTables(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  input: IxbrlArsredovisningInput,
  tables: readonly FixedAssetNoteTable[],
  warnings: string[],
): string {
  const hasOpening = tables.some((table) =>
    table.blocks.some((block) => block.rows.some((row) => row.kind === 'opening' && wholeKronor(row.amount) !== 0)),
  )
  if (hasOpening && !writer.hasContext('balans1')) {
    writer.addInstantContext('balans1', addDaysIso(input.period.start, -1))
  }
  const openingContext = writer.hasContext('balans1') ? 'balans1' : null

  const parts: string[] = []
  for (const table of tables) {
    const rows: string[] = [
      el('tr', {}, el('th', {}, '') + el('th', { class: 'num' }, escapeText(input.period.end))),
    ]
    for (const block of table.blocks) {
      for (const row of block.rows) {
        const context = row.kind === 'opening' ? openingContext : row.kind === 'closing' ? 'balans0' : 'period0'
        const concept = fixedAssetNoteConcept(registry, table.post, block.key, row)
        // A reduction of the redovisat värde prints with a minus, outside
        // the fact; a zero prints as 0, never as "−0".
        const amount = wholeKronor(row.amount)
        const displayMinus = (block.contra ? -1 : 1) * row.effect < 0 && amount !== 0
        const cell =
          concept && context ? writer.money(concept, context, amount, { displayMinus }) : plainAmount(amount, displayMinus)
        rows.push(
          el(
            'tr',
            { class: row.kind === 'closing' ? 'subtotal' : null },
            el('th', { scope: 'row', class: row.kind === 'movement' ? 'indent' : null }, escapeText(row.label)) +
              el('td', { class: 'num' }, cell),
          ),
        )
      }
    }
    rows.push(
      el(
        'tr',
        { class: 'total' },
        el('th', { scope: 'row' }, escapeText(FIXED_ASSET_CARRYING_LABEL)) +
          el('td', { class: 'num' }, carryingCell(writer, registry, input, table, warnings)),
      ),
    )
    parts.push(el('h4', {}, escapeText(table.label)), el('table', {}, rows.join('')))
  }
  return parts.join('\n')
}

/**
 * The redovisat värde repeats the balance sheet post in the same context,
 * so it is tagged only with the balance sheet's own value. A note that does
 * not tie to its post prints the figure untagged and the user is told.
 */
function carryingCell(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  input: IxbrlArsredovisningInput,
  table: FixedAssetNoteTable,
  warnings: string[],
): string {
  const carrying = wholeKronor(table.carrying)
  const taggable = table.post !== null && getConcept(registry, table.post)?.dataType === 'xbrli:monetaryItemType'
  if (!taggable || table.post === null) return plainAmount(carrying, false)
  // Exactly the post's value. A table that ties to its post already carries
  // the post's figure (alignCarryingWithBalanceSheet); one that does not
  // prints its own, as the PDF does.
  const balanceSheet = input.br[table.post]?.current ?? 0
  if (balanceSheet === carrying) return writer.money(table.post, 'balans0', carrying)
  warnings.push(
    `Anläggningsnotens redovisade värde för ${table.label} (${carrying} kr) skiljer sig från balansräkningens post (${balanceSheet} kr): beloppet i noten är inte taggat. Stäm av anläggningsregistret och notens rader mot bokföringen innan inlämning.`,
  )
  return plainAmount(carrying, false)
}
