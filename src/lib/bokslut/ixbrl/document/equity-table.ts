/**
 * The specification of changes in equity as a table: one column per equity
 * post with anything in it plus the total, one row per kind of movement,
 * every figure tagged with the taxonomy's ForandringEgetKapital<Post><Movement>
 * concept where it has one. Shared by the K3 document (fscie concepts, K3
 * 6.3) and the K2 document (se-gen-base, the same names): the registry of
 * the document decides which concepts exist, and a figure without a concept,
 * or one that moves the other way than its concept says, prints untagged
 * with a warning.
 */
import { getConcept, type TaxonomyRegistry } from '../taxonomy/registry'
import type { K3EquityInput } from '../types'
import type { FactWriter } from './ix'
import { el, escapeText, formatSekAbs } from './xml'

/** How the movement concepts name each equity post (ForandringEgetKapital<Post><Movement>). */
const FSCIE_POST_KEY: Record<string, string> = {
  Aktiekapital: 'Aktiekapital',
  EjRegistreratAktiekapital: 'EjRegistreratAktiekapital',
  OverkursfondBunden: 'BundenOverkursfond',
  Uppskrivningsfond: 'Uppskrivningsfond',
  Reservfond: 'Reservfond',
  Kapitalandelsfond: 'Kapitalandelsfond',
  FondUtvecklingsutgifter: 'FondUtvecklingsutgifter',
  Overkursfond: 'Overkursfond',
  FondVerkligtVarde: 'FondVerkligtVarde',
  BalanseratResultat: 'BalanseratResultat',
  AretsResultatEgetKapital: 'AretsResultat',
}

/**
 * Movement kind (the equity specification's keys) → the fscie movement
 * suffix. Kinds without one (an omföring, other direct-to-equity items, an
 * unclassified change) have no single concept in the taxonomy and stay
 * untagged, with a warning.
 */
const FSCIE_MOVEMENT: Record<string, string> = {
  arets_resultat: 'AretsResultat',
  resultatdisposition: 'BalanserasNyRakning',
  utdelning: 'Utdelning',
  aktieagartillskott: 'ErhallnaAktieagartillskott',
  aterbetalt_tillskott: 'AterbetalningAktieagartillskott',
  nyemission: 'Nyemission',
  fondemission: 'Fondemission',
  rattelse_av_fel: 'EffektRattelseFel',
  andrad_redovisningsprincip: 'EffektByteRedovisningsprincip',
  uppskrivning: 'UppskrivningAnlaggningstillgang',
  verkligt_varde: 'VarderingVerkligtVarde',
}

/**
 * A flow fact oriented by its concept's label: "Minskning av …" concepts
 * (utdelning, betald skatt, investeringar) count a decrease as positive and
 * print with a presentational minus; every other concept ("Ökning
 * (minskning) …", "Ökning av …", "Positiv (negativ) …") carries the signed
 * amount, a negative one with sign="-". `amount` is the signed effect (an
 * increase of equity or of cash is > 0). Null when the registry has no such
 * concept or the context is not declared.
 */
export function flowFact(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  concept: string,
  contextRef: string | null,
  amount: number,
): string | null {
  const definition = getConcept(registry, concept)
  if (!definition || contextRef === null || !writer.hasContext(contextRef)) return null
  const decrease = /^minskning/i.test(definition.label)
  // A zero prints as 0 whatever the orientation, never as "−0".
  return writer.money(concept, contextRef, decrease ? -amount : amount, { displayMinus: decrease && amount !== 0 })
}

export const signedSek = (value: number): string => escapeText(`${value < 0 ? '−' : ''}${formatSekAbs(value)}`)

/**
 * Whether a movement concept describes a change of this sign. Its standard
 * label says which way the post moves: "Minskning av ..." a decrease,
 * "Ökning av ..." an increase, "Ökning (minskning) av ..." either, and
 * "Förändring inom eget kapital ..." (the total of a transfer between
 * posts) no change of the total at all. A change the other way is not the
 * movement the concept names: a write-down against the uppskrivningsfond is
 * not an uppskrivning, and a krona left on the total of a transfer is the
 * rounding to whole kronor. Such a figure has no concept.
 */
function describes(label: string, amount: number): boolean {
  if (/^minskning/i.test(label)) return amount <= 0
  if (/^ökning av/i.test(label)) return amount >= 0
  if (/^förändring inom eget kapital/i.test(label)) return amount === 0
  return true
}

/**
 * `ForandringEgetKapital<Post><Movement>`. The K2 taxonomy spells one of
 * them without the l (ForandringEgetKapitaUppskrivningsfondFondemission):
 * the spelling the registry holds wins.
 */
function movementConcept(registry: TaxonomyRegistry, postKey: string, suffix: string): string {
  const name = `ForandringEgetKapital${postKey}${suffix}`
  const misspelled = `ForandringEgetKapita${postKey}${suffix}`
  return !getConcept(registry, name) && getConcept(registry, misspelled) ? misspelled : name
}

/** The contexts one year of the equity specification is tagged in. */
interface EquityYearContexts {
  /** The year's duration context. */
  period: string
  /** Balance at the year's start (the previous balance date), when declared. */
  opening: string | null
  /** Balance at the year's end. */
  closing: string
}

/**
 * One year of the equity specification as a table: one column per post with
 * anything in it, plus the total. Returns the table without a heading.
 */
export function renderEquityTable(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  equity: Pick<K3EquityInput, 'kinds'>,
  yearPosts: K3EquityInput['posts'],
  ctx: EquityYearContexts,
  warnings: string[],
): string {
  const posts = yearPosts.filter(
    (post) => post.opening !== 0 || post.closing !== 0 || Object.values(post.movements).some((amount) => amount !== 0),
  )
  if (posts.length === 0) return ''
  const td = (content: string): string => el('td', { class: 'num' }, content)
  const head = el(
    'tr',
    {},
    el('th', {}, 'Förändringar i eget kapital') +
      posts.map((post) => el('th', { class: 'num' }, escapeText(post.label))).join('') +
      el('th', { class: 'num' }, 'Totalt'),
  )
  const rows: string[] = [head]
  const total = (pick: (post: (typeof posts)[number]) => number) => posts.reduce((sum, post) => sum + pick(post), 0)

  // A first year has no balance date before it: no opening row.
  const opening = ctx.opening
  if (opening) {
    rows.push(
      el(
        'tr',
        {},
        el('th', {}, 'Belopp vid årets ingång') +
          posts.map((post) => td(writer.money(post.concept, opening, post.opening))).join('') +
          td(writer.money('EgetKapital', opening, total((post) => post.opening))),
      ),
    )
  }

  const untagged = new Set<string>()
  for (const { kind, label } of equity.kinds) {
    const amounts = posts.map((post) => post.movements[kind] ?? 0)
    if (amounts.every((amount) => amount === 0)) continue
    const suffix = FSCIE_MOVEMENT[kind] ?? null
    // The fact of a figure, when the registry has the concept and the
    // concept describes a change of this sign (describes above).
    const tagged = (concept: string | null, amount: number): string | null => {
      const definition = concept ? getConcept(registry, concept) : null
      if (!concept || !definition || !describes(definition.label, amount)) return null
      // An instant movement concept (the effect of a correction or a change
      // of principle) adjusts the opening balance: it is tagged at the year's
      // start, the previous year's balance date.
      return flowFact(writer, registry, concept, definition.periodType === 'instant' ? ctx.opening : ctx.period, amount)
    }
    const cells = posts.map((post, index) => {
      const amount = amounts[index]
      if (amount === 0) return td('')
      const postKey = FSCIE_POST_KEY[post.concept]
      const fact = tagged(suffix && postKey ? movementConcept(registry, postKey, suffix) : null, amount)
      if (fact === null) untagged.add(`${label} (${post.label})`)
      return td(fact ?? signedSek(amount))
    })
    const sum = amounts.reduce((a, b) => a + b, 0)
    const totalFact = tagged(suffix ? `ForandringEgetKapitalTotalt${suffix}` : null, sum)
    if (totalFact === null) untagged.add(`${label} (totalt)`)
    rows.push(el('tr', {}, el('th', {}, escapeText(label)) + cells.join('') + td(totalFact ?? signedSek(sum))))
  }
  if (untagged.size > 0) {
    warnings.push(
      `Förändringar i eget kapital: ${[...untagged].join(', ')} har inget eget begrepp i taxonomin och lämnas otaggade: granska raderna innan inlämning.`,
    )
  }

  rows.push(
    el(
      'tr',
      { class: 'subtotal' },
      el('th', {}, 'Belopp vid årets utgång') +
        posts.map((post) => td(writer.money(post.concept, ctx.closing, post.closing))).join('') +
        td(writer.money('EgetKapital', ctx.closing, total((post) => post.closing))),
    ),
  )
  return el('table', { class: tableClass(posts.length) }, rows.join(''))
}

/**
 * One column per post is more than a sheet holds at the document's size: the
 * column headings wrap, and from five posts the type shrinks in steps
 * (layout.ts), so the Totalt column stays on the sheet in print.
 */
function tableClass(posts: number): string {
  if (posts > 8) return 'ar-equity ar-cols-xl'
  if (posts > 6) return 'ar-equity ar-cols-l'
  if (posts > 4) return 'ar-equity ar-cols-m'
  return 'ar-equity'
}
