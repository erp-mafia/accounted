/**
 * K3 AB årsredovisning → iXBRL 1.1 XHTML document (entry point K3 AB risbs
 * 2021-10-31, revised 2026-08-31).
 *
 * The same envelope, title page, fastställelseintyg, flerårsöversikt,
 * resultatdisposition, notes and signatures as the K2 document (layout.ts,
 * sections.ts), with what K3 has of its own, following Bolagsverket's
 * official K3 example 3 (2021):
 *   - allmän information without BeloppsformatList (not in K3) and with the
 *     amounts sentence tagged as MatEnhet;
 *   - förvaltningsberättelse in K3 concepts: VerksamhetenArtInriktning,
 *     ViktigaForhallandenVasentligaHandelser, the K3 3.7 items the
 *     disclosure matrix produces, Kontrollbalansrakning;
 *   - the specification of changes in equity per equity post (fscie
 *     concepts ForandringEgetKapital<Post><Movement>), placed in the
 *     förvaltningsberättelse as K3 3.10 allows and the example does;
 *   - resultaträkning and balansräkning in the K3 forms' order and names
 *     (fisbn, fbs), K3's own posts included;
 *   - the kassaflödesanalys (fcf) when the report includes one.
 * Every fact goes through the K3 registry: a concept outside the K3 risbs
 * forms fails generation instead of reaching Bolagsverket.
 */

import { formatOrgNumber } from '@/lib/utils'
import { getEntryPoint } from '../taxonomy/entry-points'
import { getConcept, getRegistry, type TaxonomyRegistry } from '../taxonomy/registry'
import type { IxbrlArsredovisningInput, K3CashFlowInput, K3EquityInput } from '../types'
import { K3_CASH_FLOW_RESULT_LINES, k3ConceptAmounts } from '../k3-adapters'
import { FactWriter } from './ix'
import { assembleXhtml, fmtRange, registerContexts, type Ctx, type GeneratedIxbrl } from './layout'
import {
  emitAllmanInformation,
  renderCoverPage,
  renderFlerarsoversikt,
  renderNotes,
  renderResultatdisposition,
  renderSignatures,
} from './sections'
import {
  K3_BALANSRAKNING_EGET_KAPITAL_SKULDER,
  K3_BALANSRAKNING_TILLGANGAR,
  K3_RESULTATRAKNING,
  renderStatementRows,
  statementHead,
} from './statements'
import { el, escapeText, formatSekAbs, paragraphs } from './xml'

/** How the fscie concepts name each equity post (ForandringEgetKapital<Post><Movement>). */
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
function flowFact(
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

const signedSek = (value: number): string => escapeText(`${value < 0 ? '−' : ''}${formatSekAbs(value)}`)

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
function renderEquityTable(
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
    // An instant movement concept (the effect of a correction or a change
    // of principle) adjusts the opening balance: it is tagged at the year's
    // start, the previous year's balance date.
    const contextFor = (concept: string): string | null => {
      const definition = getConcept(registry, concept)
      if (!definition) return null
      return definition.periodType === 'instant' ? ctx.opening : ctx.period
    }
    const cells = posts.map((post, index) => {
      const amount = amounts[index]
      if (amount === 0) return td('')
      const postKey = FSCIE_POST_KEY[post.concept]
      const concept = suffix && postKey ? `ForandringEgetKapital${postKey}${suffix}` : null
      const fact = concept ? flowFact(writer, registry, concept, contextFor(concept), amount) : null
      if (fact === null) untagged.add(`${label} (${post.label})`)
      return td(fact ?? signedSek(amount))
    })
    const sum = amounts.reduce((a, b) => a + b, 0)
    const totalConcept = suffix ? `ForandringEgetKapitalTotalt${suffix}` : null
    const totalFact = totalConcept ? flowFact(writer, registry, totalConcept, contextFor(totalConcept), sum) : null
    if (totalFact === null) untagged.add(`${label} (totalt)`)
    rows.push(el('tr', {}, el('th', {}, escapeText(label)) + cells.join('') + td(totalFact ?? signedSek(sum))))
  }
  if (untagged.size > 0) {
    warnings.push(
      `Förändringar i eget kapital: ${[...untagged].join(', ')} har inget eget begrepp i K3-taxonomin och lämnas otaggade: granska raderna innan inlämning.`,
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
  return el('table', {}, rows.join(''))
}

/**
 * The equity specification where the report places it: in the
 * förvaltningsberättelse the year only; as a statement of its own both
 * years, the jämförelseår first (as the PDF prints it), its opening at the
 * balance date before the jämförelseår (balans2).
 */
function renderEquity(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  input: IxbrlArsredovisningInput,
  equity: K3EquityInput,
  ctx: Ctx,
  warnings: string[],
): string {
  const current = renderEquityTable(
    writer,
    registry,
    equity,
    equity.posts,
    { period: ctx.period0, opening: ctx.balans1, closing: ctx.balans0 },
    warnings,
  )
  if (equity.placement === 'management_report') {
    return current ? el('h3', {}, 'Förändringar i eget kapital') + current : ''
  }
  const parts: string[] = [el('h2', {}, 'Förändring av eget kapital (kr)')]
  if (equity.previous && ctx.period1 && ctx.balans1 && input.previousPeriod) {
    const previous = renderEquityTable(
      writer,
      registry,
      equity,
      equity.previous,
      { period: ctx.period1, opening: writer.hasContext('balans2') ? 'balans2' : null, closing: ctx.balans1 },
      warnings,
    )
    if (previous) parts.push(el('h3', {}, escapeText(fmtRange(input.previousPeriod.start, input.previousPeriod.end))), previous)
  }
  if (current) parts.push(el('h3', {}, escapeText(fmtRange(input.period.start, input.period.end))), current)
  return parts.length > 1 ? parts.join('\n') : ''
}

/** The ISO date before `iso` (the balance date that precedes a year's start). */
function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/** Kassaflödesanalys (indirekt metod), K3 chapter 7 layout, fcf concepts. */
function renderCashFlow(
  writer: FactWriter,
  registry: TaxonomyRegistry,
  input: IxbrlArsredovisningInput,
  cashFlow: K3CashFlowInput,
  ctx: Ctx,
): string {
  // The result lines repeat RR facts in the same contexts: they carry the
  // RR's figures, so the duplicates are value-identical (TA §2.7.3).
  // Preflight (ACC-K3-KFA-RESULT) refuses a statement whose own figure differs.
  const fromRr: Readonly<Record<string, keyof IxbrlArsredovisningInput['totals']>> = K3_CASH_FLOW_RESULT_LINES
  const head = statementHead(
    'Kassaflödesanalys (kr)',
    fmtRange(input.period.start, input.period.end),
    input.previousPeriod ? fmtRange(input.previousPeriod.start, input.previousPeriod.end) : '',
  )
  const rows: string[] = [head]
  const SECTION_TITLES: Record<string, string> = {
    lopande: 'Den löpande verksamheten',
    investering: 'Investeringsverksamheten',
    finansiering: 'Finansieringsverksamheten',
  }
  let lastSection = ''
  for (const row of cashFlow.rows) {
    const rrTotal = row.concept ? fromRr[row.concept] : undefined
    const current = rrTotal ? input.totals[rrTotal].current : row.current
    // A statement without a comparative year leaves the column empty, the
    // result line included.
    const previous = row.previous === null ? null : rrTotal ? input.totals[rrTotal].previous : row.previous
    if (!row.alwaysShow && current === 0 && (previous === null || previous === 0)) continue
    if (row.section !== lastSection) {
      const title = SECTION_TITLES[row.section]
      if (title) rows.push(el('tr', { class: 'section' }, el('th', { colspan: '3' }, escapeText(title))))
      lastSection = row.section
    }
    const contexts =
      row.instant === 'start'
        ? { current: ctx.balans1, previous: writer.hasContext('balans2') ? 'balans2' : null }
        : row.instant === 'end'
          ? { current: ctx.balans0, previous: ctx.balans1 }
          : { current: ctx.period0, previous: ctx.period1 }
    const cell = (amount: number | null, contextRef: string | null): string => {
      if (amount === null) return ''
      if (row.concept && row.instant) {
        return contextRef && writer.hasContext(contextRef) ? writer.money(row.concept, contextRef, amount) : signedSek(amount)
      }
      const fact = row.concept ? flowFact(writer, registry, row.concept, contextRef, amount) : null
      return fact ?? signedSek(amount)
    }
    rows.push(
      el(
        'tr',
        { class: row.kind === 'line' ? null : row.kind === 'subtotal' ? 'subtotal' : 'total' },
        el('th', { scope: 'row', class: row.kind === 'line' ? 'indent' : null }, escapeText(row.label)) +
          el('td', { class: 'num' }, cell(current, contexts.current)) +
          el('td', { class: 'num' }, ctx.period1 ? cell(previous, contexts.previous) : ''),
      ),
    )
  }
  return el('h2', {}, 'Kassaflödesanalys') + el('table', {}, rows.join(''))
}

export function generateK3IxbrlDocument(input: IxbrlArsredovisningInput): GeneratedIxbrl {
  const entryPoint = getEntryPoint(input.entryPointId)
  if (entryPoint.regelverk !== 'K3') {
    throw new Error(`generateK3IxbrlDocument: entry point ${entryPoint.id} is not a K3 entry point`)
  }
  if (!input.k3) throw new Error('generateK3IxbrlDocument: the input carries no K3 part (k3)')
  const k3 = input.k3
  const registry = getRegistry(entryPoint.registryId)
  const orgNumber = formatOrgNumber(input.company.orgNumber)
  const writer = new FactWriter(entryPoint, registry, orgNumber)
  const warnings: string[] = [...input.warnings]

  const ctx = registerContexts(writer, input)
  // A separate equity statement shows the jämförelseår from its opening
  // balance: the balance date before it, declared here when the
  // flerårsöversikt did not (the kassaflödesanalys tags its likvida medel
  // there too).
  if (k3.equity.placement === 'separate_statement' && k3.equity.previous && input.previousPeriod && !writer.hasContext('balans2')) {
    writer.addInstantContext('balans2', dayBefore(input.previousPeriod.start))
  }
  const yearCtx = { current: ctx.period0, previous: ctx.period1 }
  const balCtx = { current: ctx.balans0, previous: ctx.balans1 }
  const { rr, br } = k3ConceptAmounts(input.rr, input.br)

  emitAllmanInformation(writer, input, { beloppsformat: false })

  const pages: string[] = []

  // ====== Titel + innehåll + fastställelseintyg ======
  pages.push(renderCoverPage(writer, input, orgNumber, { matEnhet: true }))

  // ====== Förvaltningsberättelse ======
  {
    const fb = input.forvaltningsberattelse
    const parts: string[] = [
      el('h2', {}, 'Förvaltningsberättelse'),
      el('h3', {}, 'Verksamheten'),
      el('h4', {}, 'Allmänt om verksamheten'),
      writer.textHtml('VerksamhetenArtInriktning', 'period0', paragraphs(fb.allmantOmVerksamheten)),
      el('h4', {}, 'Väsentliga händelser under räkenskapsåret'),
      writer.textHtml('ViktigaForhallandenVasentligaHandelser', 'period0', paragraphs(fb.vasentligaHandelser)),
    ]
    for (const item of k3.forvaltningsberattelse) {
      if (!item.text.trim()) continue
      const definition = item.concept ? getConcept(registry, item.concept) : null
      const taggable =
        definition !== null && definition.dataType === 'xbrli:stringItemType' && definition.periodType === 'duration'
      parts.push(
        el('h4', {}, escapeText(item.heading)),
        taggable ? writer.textHtml(item.concept!, 'period0', paragraphs(item.text)) : paragraphs(item.text),
      )
      if (item.concept && !taggable) {
        warnings.push(`Förvaltningsberättelsen: "${item.heading}" har inget K3-begrepp (${item.concept}) och lämnas otaggad.`)
      }
    }
    if (fb.kontrollbalansrakningUpprattad) {
      parts.push(
        el('h4', {}, 'Kontrollbalansräkning'),
        el(
          'p',
          {},
          writer.textPlain(
            'Kontrollbalansrakning',
            'period0',
            'Kontrollbalansräkning har upprättats under räkenskapsåret enligt ABL 25 kap.',
          ),
        ),
      )
    }
    const flerars = renderFlerarsoversikt(writer, fb.flerarsoversikt)
    if (flerars) parts.push(flerars)
    if (k3.equity.placement === 'management_report') {
      const equity = renderEquity(writer, registry, input, k3.equity, ctx, warnings)
      if (equity) parts.push(equity)
    }
    parts.push(...renderResultatdisposition(writer, fb.resultatdisposition))
    pages.push(parts.join('\n'))
  }

  // ====== Resultaträkning ======
  {
    const head = statementHead(
      'Resultaträkning (kr)',
      fmtRange(input.period.start, input.period.end),
      input.previousPeriod ? fmtRange(input.previousPeriod.start, input.previousPeriod.end) : '',
    )
    const rows = [head, ...renderStatementRows(writer, K3_RESULTATRAKNING, rr, input.totals, yearCtx)]
    pages.push(el('h2', {}, 'Resultaträkning') + el('table', {}, rows.filter(Boolean).join('')))
  }

  // ====== Balansräkning ======
  {
    const head = (title: string): string =>
      statementHead(title, input.period.end, input.previousPeriod ? input.previousPeriod.end : '')
    const assetRows = [
      head('Balansräkning: Tillgångar (kr)'),
      ...renderStatementRows(writer, K3_BALANSRAKNING_TILLGANGAR, br, input.totals, balCtx),
    ]
    const eqRows = [
      head('Balansräkning: Eget kapital och skulder (kr)'),
      ...renderStatementRows(writer, K3_BALANSRAKNING_EGET_KAPITAL_SKULDER, br, input.totals, balCtx),
    ]
    pages.push(
      el('h2', {}, 'Balansräkning') + el('table', {}, assetRows.filter(Boolean).join('')),
      el('h2', {}, 'Balansräkning') + el('table', {}, eqRows.filter(Boolean).join('')),
    )
  }

  // ====== Kassaflödesanalys ======
  if (k3.cashFlow) pages.push(renderCashFlow(writer, registry, input, k3.cashFlow, ctx))

  // ====== Förändring av eget kapital, as a statement of its own ======
  if (k3.equity.placement === 'separate_statement') {
    const equity = renderEquity(writer, registry, input, k3.equity, ctx, warnings)
    if (equity) pages.push(equity)
  }

  // ====== Noter ======
  pages.push(renderNotes(writer, registry, input, ctx, warnings))

  // ====== Underskrifter ======
  pages.push(renderSignatures(writer, registry, input))

  return { xhtml: assembleXhtml(input, entryPoint, writer, pages, orgNumber), warnings }
}
