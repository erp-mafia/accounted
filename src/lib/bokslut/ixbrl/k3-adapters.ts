/**
 * The seams between the K3 iXBRL document and the K3 data other phases of
 * the K3 build produce. ONE adapter per seam, so each switches source in one
 * place when its producer lands on main:
 *
 *   1. K3 balance sheet posts (P1, k3-presentation.ts): toK3Presentation
 *      carves K3's own posts out of the K2 mapping and marks the result
 *      `presentation: 'k3'`. The document tags such a mapping's posts as
 *      they are; on a plain K2 mapping (today's main) the K3 posts stay
 *      folded into their K2 posts (k3BalanceSheetSource says which). Either
 *      way the K2 names K3 does not use are renamed (k3ConceptAmounts).
 *   2. Equity specification (P1, equity-specification.ts): the report's
 *      `equity_specification`, per post and movement kind from the ledger.
 *      Without one, k3EquityInput derives the movements from closing
 *      balances and marks the input `closing_balances`, which preflight
 *      refuses to file (ACC-K3-EQUITY-SOURCE).
 *   3. Kassaflödesanalys (P4, lib/bokslut/kassaflodesanalys): a K3 chapter 7
 *      statement keyed by line, with a taxonomy concept per line. Without
 *      one, k3CashFlowInput maps the older summary report and marks it
 *      `summary`, which preflight refuses to file (ACC-K3-KFA-SOURCE).
 *   4. Förvaltningsberättelse items (P1, disclosure matrix): K3 3.7 c-g and
 *      the other texts K3 asks for, by fdr concept. Empty until the matrix
 *      lands; verksamheten and väsentliga händelser come from the report as
 *      for K2.
 *
 * The shapes read here are structural (duck-typed) on purpose: the producers
 * are not on main yet, and core must not import a module that does not exist.
 */

import { roundOre } from '@/lib/money'
import { KASSAFLODESANALYS_LAYOUT } from '@/lib/reports/kassaflodesanalys-layout'
import type {
  ConceptAmount,
  ConceptAmounts,
  IxbrlArsredovisningInput,
  K3CashFlowInput,
  K3CashFlowRow,
  K3EquityInput,
  K3EquityPost,
} from './types'

// ---- 1. balance sheet posts ---------------------------------------------

/**
 * K2 concepts the K3 forms name differently. Verified against the K3 AB
 * 2021-10-31 (rev 2026-08-31) registry: the K2 names are not in the K3
 * risbs forms (OvrigaBokslutsdispositioner survives only inside a note).
 */
export const K3_CONCEPT_RENAMES = {
  rr: { OvrigaBokslutsdispositioner: 'AndraBokslutsdispositioner' },
  br: {
    OvrigaObeskattadeReserver: 'AndraObeskattadeReserver',
    ForskottImmateriellaAnlaggningstillgangar: 'PagaendeUtvecklingsarbetenForskottImmateriellaAnlaggningstillgangar',
  },
} as const

function addAmounts(a: ConceptAmount | undefined, b: ConceptAmount): ConceptAmount {
  if (!a) return { ...b }
  return {
    current: a.current + b.current,
    previous: a.previous === null && b.previous === null ? null : (a.previous ?? 0) + (b.previous ?? 0),
  }
}

function renamed(amounts: ConceptAmounts, renames: Readonly<Record<string, string>>): ConceptAmounts {
  const out: ConceptAmounts = {}
  for (const [concept, amount] of Object.entries(amounts)) {
    const target = renames[concept] ?? concept
    out[target] = addAmounts(out[target], amount)
  }
  return out
}

/**
 * Where the K3 balance sheet's own posts come from: a mapping P1's
 * toK3Presentation produced (K3's own posts carved out), or a plain K2
 * mapping (today's main: they stay folded into their K2 posts).
 */
export function k3BalanceSheetSource(mapping: object): 'k3_presentation' | 'k2_mapping' {
  return (mapping as { presentation?: unknown }).presentation === 'k3' ? 'k3_presentation' : 'k2_mapping'
}

/**
 * The statements under K3's concept names. The iXBRL input keeps the
 * mapper's keys, which the PDF rows and the statement-integrity check are
 * built from; the K3 document renames when it tags.
 */
export function k3ConceptAmounts(rr: ConceptAmounts, br: ConceptAmounts): { rr: ConceptAmounts; br: ConceptAmounts } {
  return { rr: renamed(rr, K3_CONCEPT_RENAMES.rr), br: renamed(br, K3_CONCEPT_RENAMES.br) }
}

// ---- 2. equity specification ---------------------------------------------

/** The equity posts of the K3 balance sheet, in ÅRL bilaga 1 order. */
export const K3_EQUITY_POSTS: ReadonlyArray<{ concept: string; label: string; bound: boolean }> = [
  { concept: 'Aktiekapital', label: 'Aktiekapital', bound: true },
  { concept: 'EjRegistreratAktiekapital', label: 'Ej registrerat aktiekapital', bound: true },
  { concept: 'OverkursfondBunden', label: 'Bunden överkursfond', bound: true },
  { concept: 'Uppskrivningsfond', label: 'Uppskrivningsfond', bound: true },
  { concept: 'Reservfond', label: 'Reservfond', bound: true },
  { concept: 'FondUtvecklingsutgifter', label: 'Fond för utvecklingsutgifter', bound: true },
  { concept: 'Overkursfond', label: 'Fri överkursfond', bound: false },
  { concept: 'FondVerkligtVarde', label: 'Fond för verkligt värde', bound: false },
  { concept: 'BalanseratResultat', label: 'Balanserat resultat', bound: false },
  { concept: 'AretsResultatEgetKapital', label: 'Årets resultat', bound: false },
]

/** The equity specification's year, as equity-specification.ts builds it (amounts in kronor with öre). */
interface EquitySpecificationYearLike {
  posts: Array<{ concept: string; label: string; bound: boolean; opening: number; closing: number; movements: Partial<Record<string, number>> }>
}
interface EquitySpecificationLike {
  current: EquitySpecificationYearLike
  previous?: EquitySpecificationYearLike | null
  kinds: string[]
  placement?: 'management_report' | 'separate_statement'
}

function isEquitySpecification(value: unknown): value is EquitySpecificationLike {
  const spec = value as EquitySpecificationLike | null | undefined
  return Boolean(spec && Array.isArray(spec.kinds) && spec.current && Array.isArray(spec.current.posts))
}

/** Whole kronor, as every other figure of the document; -0 read as 0. */
function whole(amount: number): number {
  const rounded = Math.round(roundOre(amount))
  return rounded === 0 ? 0 : rounded
}

/** Row labels of the specification's movement kinds (K3 6.3 a-e). */
const KIND_LABELS: Record<string, string> = {
  rattelse_av_fel: 'Effekt av rättelse av fel',
  andrad_redovisningsprincip: 'Effekt av ändrad redovisningsprincip',
  resultatdisposition: 'Disposition enligt stämmans beslut',
  utdelning: 'Utdelning',
  aktieagartillskott: 'Erhållna tillskott',
  aterbetalt_tillskott: 'Återbetalda tillskott',
  nyemission: 'Nyemission',
  andra_vardeoverforingar: 'Andra värdeöverföringar till ägare',
  fondemission: 'Fondemission',
  omforing: 'Omföring mellan poster i eget kapital',
  uppskrivning: 'Uppskrivning av anläggningstillgångar',
  verkligt_varde: 'Förändring av verkligt värde',
  ovriga_direkt_mot_eget_kapital: 'Övriga poster redovisade direkt mot eget kapital',
  ovrigt: 'Övriga förändringar',
  arets_resultat: 'Årets resultat',
}

const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind

function specificationPosts(year: EquitySpecificationYearLike, br: ConceptAmounts, field: 'current' | 'previous'): K3EquityPost[] {
  return year.posts.map((post) => ({
    concept: post.concept,
    label: post.label,
    bound: post.bound,
    opening: whole(post.opening),
    // The balance sheet's own figure: the specification ties to it
    // (equitySpecificationIssues), and the document repeats the BR fact.
    closing: br[post.concept]?.[field] ?? whole(post.closing),
    movements: Object.fromEntries(
      Object.entries(post.movements)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
        .map(([kind, amount]) => [kind, whole(amount)]),
    ),
  }))
}

export function k3EquityFromSpecification(spec: EquitySpecificationLike, br: ConceptAmounts): K3EquityInput {
  return {
    source: 'ledger',
    kinds: spec.kinds.map((kind) => ({ kind, label: kindLabel(kind) })),
    posts: specificationPosts(spec.current, br, 'current'),
    placement: spec.placement === 'separate_statement' ? 'separate_statement' : 'management_report',
    previous: spec.previous ? specificationPosts(spec.previous, br, 'previous') : null,
  }
}

/**
 * Today's fallback: movements read off the balances, as the K2 document
 * does. Last year's result is carried forward (resultatdisposition), a fall
 * in balanserat resultat beyond it is shown as utdelning, a change of
 * aktiekapital as nyemission, anything else as övriga förändringar. It is
 * a reading of balances, not of the year's verifikat, so preflight refuses
 * to file it.
 */
export function k3EquityFromClosingBalances(br: ConceptAmounts): K3EquityInput {
  const ib = (concept: string) => br[concept]?.previous ?? 0
  const ub = (concept: string) => br[concept]?.current ?? 0
  const carried = ib('AretsResultatEgetKapital')
  const balanseratResidual = ub('BalanseratResultat') - (ib('BalanseratResultat') + carried)
  const posts: K3EquityPost[] = []
  for (const post of K3_EQUITY_POSTS) {
    const opening = ib(post.concept)
    const closing = ub(post.concept)
    if (opening === 0 && closing === 0) continue
    const movements: Record<string, number> = {}
    if (post.concept === 'AretsResultatEgetKapital') {
      if (carried !== 0) movements.resultatdisposition = -carried
      movements.arets_resultat = closing
    } else if (post.concept === 'BalanseratResultat') {
      if (carried !== 0) movements.resultatdisposition = carried
      if (balanseratResidual < 0) movements.utdelning = balanseratResidual
      if (balanseratResidual > 0) movements.ovrigt = balanseratResidual
    } else if (post.concept === 'Aktiekapital') {
      if (closing !== opening) movements.nyemission = closing - opening
    } else if (closing !== opening) {
      movements.ovrigt = closing - opening
    }
    posts.push({ concept: post.concept, label: post.label, bound: post.bound, opening, closing, movements })
  }
  const kinds = ['resultatdisposition', 'utdelning', 'nyemission', 'ovrigt', 'arets_resultat']
  return {
    source: 'closing_balances',
    kinds: kinds.map((kind) => ({ kind, label: kindLabel(kind) })),
    posts,
    placement: 'management_report',
    previous: null,
  }
}

/** The equity input for a report: its specification when it has one, else the fallback. */
export function k3EquityInput(report: unknown, br: ConceptAmounts): K3EquityInput {
  const spec = (report as { equity_specification?: unknown } | null)?.equity_specification
  return isEquitySpecification(spec) ? k3EquityFromSpecification(spec, br) : k3EquityFromClosingBalances(br)
}

// ---- 3. kassaflödesanalys ---------------------------------------------------

/**
 * The K3 chapter 7 lines: the kassaflödesanalys layout itself (keys, labels
 * and concepts in order), so the iXBRL and the report cannot drift. Likvida
 * medel is an instant concept, read at the year's start for _ib and at its
 * end for _ub.
 */
const CHAPTER7_ROWS: ReadonlyArray<Omit<K3CashFlowRow, 'current' | 'previous'>> = KASSAFLODESANALYS_LAYOUT.map((row) => ({
  ...row,
  ...(row.key === 'likvida_medel_ib'
    ? { instant: 'start' as const }
    : row.key === 'likvida_medel_ub'
      ? { instant: 'end' as const }
      : {}),
}))

/**
 * Cash flow lines that repeat an RR total (the statement starts from
 * rörelseresultat in chapter 7, from resultat efter finansiella poster in
 * the summary), by concept: the K3 document tags them with the RR's figure.
 */
export const K3_CASH_FLOW_RESULT_LINES = {
  Rorelseresultat: 'rorelseresultat',
  ResultatEfterFinansiellaPoster: 'resultatEfterFinansiellaPoster',
  AretsResultat: 'aretsResultat',
} as const satisfies Record<string, keyof IxbrlArsredovisningInput['totals']>

interface Chapter7YearLike {
  amounts: Record<string, number>
  reconciliation: { is_reconciled: boolean }
}
interface Chapter7StatementLike {
  current: Chapter7YearLike
  previous: Chapter7YearLike | null
}

function isChapter7Statement(value: unknown): value is Chapter7StatementLike {
  const statement = value as Chapter7StatementLike | null | undefined
  return Boolean(statement?.current?.amounts && typeof statement.current.amounts === 'object')
}

export function k3CashFlowFromStatement(statement: Chapter7StatementLike): K3CashFlowInput {
  return {
    source: 'chapter7',
    rows: CHAPTER7_ROWS.map((row) => ({
      ...row,
      current: whole(statement.current.amounts[row.key] ?? 0),
      previous: statement.previous ? whole(statement.previous.amounts[row.key] ?? 0) : null,
    })),
    reconciled:
      statement.current.reconciliation.is_reconciled &&
      (statement.previous === null || statement.previous.reconciliation.is_reconciled),
  }
}

/** The summary report's shape (lib/reports/kassaflodesanalys.ts on main). */
interface CashFlowSummaryLike {
  lopande: Record<string, number>
  investerings: Record<string, number>
  finansierings: Record<string, number>
  total_cash_flow: number
  reconciliation: { opening_cash_1xxx: number; closing_cash_1xxx: number; is_reconciled: boolean }
}

/** Which part of the statement each summary line belongs to. */
const SUMMARY_SECTIONS = {
  resultat_efter_finansiella_poster: 'lopande',
  justeringar_ej_kassaflode: 'lopande',
  betald_inkomstskatt: 'lopande',
  koncernbidrag: 'lopande',
  kassaflode_fore_rorelsekapital: 'lopande',
  forandring_varulager: 'lopande',
  forandring_rorelsefordringar: 'lopande',
  forandring_rorelseskulder: 'lopande',
  ovriga_poster: 'lopande',
  kassaflode_lopande: 'lopande',
  forvarv_anlaggningar: 'investering',
  avyttring_anlaggningar: 'investering',
  forandring_kortfristiga_placeringar: 'investering',
  kassaflode_investering: 'investering',
  forandring_lan: 'finansiering',
  nyemission: 'finansiering',
  erhallna_aktieagartillskott: 'finansiering',
  utbetald_utdelning: 'finansiering',
  kassaflode_finansiering: 'finansiering',
  arets_kassaflode: 'likvida_medel',
  likvida_medel_ib: 'likvida_medel',
  likvida_medel_ub: 'likvida_medel',
} as const satisfies Record<string, K3CashFlowRow['section']>

/**
 * Today's fallback: the summary report, one year, net investing and
 * financing flows. Only lines with a matching taxonomy concept are tagged;
 * net acquisitions/disposals and net borrowing stay untagged (K3 7.11 asks
 * for them gross). Preflight refuses to file it.
 */
export function k3CashFlowFromSummary(summary: CashFlowSummaryLike): K3CashFlowInput {
  const l = summary.lopande
  const i = summary.investerings
  const f = summary.finansierings
  const row = (
    key: keyof typeof SUMMARY_SECTIONS,
    label: string,
    concept: string | null,
    amount: number,
    opts: { kind?: K3CashFlowRow['kind']; alwaysShow?: boolean; instant?: 'start' | 'end' } = {},
  ): K3CashFlowRow => ({
    key,
    section: SUMMARY_SECTIONS[key],
    label,
    concept,
    kind: opts.kind ?? 'line',
    current: whole(amount),
    previous: null,
    alwaysShow: opts.alwaysShow ?? false,
    ...(opts.instant ? { instant: opts.instant } : {}),
  })
  const foreRorelsekapital =
    (l.resultat_efter_finansiella_poster ?? 0) +
    (l.avskrivningar ?? 0) +
    (l.ovriga_ej_kassaflodesposter ?? 0) +
    (l.skatt_betald ?? 0) +
    (l.koncernbidrag ?? 0)
  return {
    source: 'summary',
    rows: [
      row('resultat_efter_finansiella_poster', 'Resultat efter finansiella poster', 'ResultatEfterFinansiellaPoster', l.resultat_efter_finansiella_poster ?? 0, { alwaysShow: true }),
      row('justeringar_ej_kassaflode', 'Justeringar för poster som inte ingår i kassaflödet', 'JusteringPosterSomInteIngarIKassaflodet', (l.avskrivningar ?? 0) + (l.ovriga_ej_kassaflodesposter ?? 0), { alwaysShow: true }),
      row('betald_inkomstskatt', 'Betald inkomstskatt', 'BetaldSkatt', l.skatt_betald ?? 0, { alwaysShow: true }),
      row('koncernbidrag', 'Erhållna och lämnade koncernbidrag', null, l.koncernbidrag ?? 0),
      row('kassaflode_fore_rorelsekapital', 'Kassaflöde från den löpande verksamheten före förändringar av rörelsekapital', 'KassaflodeLopandeVerksamhetenForeForandringarRorelsekapital', foreRorelsekapital, { kind: 'subtotal', alwaysShow: true }),
      row('forandring_varulager', 'Förändring av varulager', 'ForandringKassaflodeVarulagerPagaendeArbeten', l.delta_varulager ?? 0),
      row('forandring_rorelsefordringar', 'Förändring av rörelsefordringar', 'ForandringKassaflodeRorelsefodringar', l.delta_kortfristiga_fordringar ?? 0, { alwaysShow: true }),
      row('forandring_rorelseskulder', 'Förändring av rörelseskulder', 'ForandringKassaflodeRorelseskulder', l.delta_kortfristiga_skulder ?? 0, { alwaysShow: true }),
      row('ovriga_poster', 'Övriga poster', null, l.ovriga_poster ?? 0),
      row('kassaflode_lopande', 'Kassaflöde från den löpande verksamheten', 'KassaflodeLopandeVerksamheten', l.total ?? 0, { kind: 'total', alwaysShow: true }),
      row('forvarv_anlaggningar', 'Förvärv av anläggningstillgångar', null, i.forvarv_anlaggningar ?? 0),
      row('avyttring_anlaggningar', 'Avyttring av anläggningstillgångar', null, i.avyttring_anlaggningar ?? 0),
      row('forandring_kortfristiga_placeringar', 'Förändring av kortfristiga placeringar', 'ForandringKassaflodeOvrigaKortfristigaPlaceringar', i.kortfristiga_placeringar ?? 0),
      row('kassaflode_investering', 'Kassaflöde från investeringsverksamheten', 'KassaflodeInvesteringsverksamheten', i.total ?? 0, { kind: 'total', alwaysShow: true }),
      row('forandring_lan', 'Förändring av lån', null, f.delta_lan ?? 0),
      row('nyemission', 'Nyemission', 'NyemissionKassaflode', f.nyemission ?? 0),
      row('erhallna_aktieagartillskott', 'Erhållna aktieägartillskott', 'ErhallnaAktieagartillskottKassaflode', f.erhallna_aktieagartillskott ?? 0),
      row('utbetald_utdelning', 'Utbetald utdelning', 'UtbetaldUtdelningKassaflode', f.utdelningar ?? 0),
      row('kassaflode_finansiering', 'Kassaflöde från finansieringsverksamheten', 'KassaflodeFinansieringsverksamheten', f.total ?? 0, { kind: 'total', alwaysShow: true }),
      row('arets_kassaflode', 'Årets kassaflöde', 'AretsKassaflode', summary.total_cash_flow, { kind: 'total', alwaysShow: true }),
      row('likvida_medel_ib', 'Likvida medel vid årets början', 'LikvidaMedel', summary.reconciliation.opening_cash_1xxx, { alwaysShow: true, instant: 'start' }),
      row('likvida_medel_ub', 'Likvida medel vid årets slut', 'LikvidaMedel', summary.reconciliation.closing_cash_1xxx, { kind: 'total', alwaysShow: true, instant: 'end' }),
    ],
    reconciled: summary.reconciliation.is_reconciled,
  }
}

/** The report's kassaflödesanalys for the document, or null when it is left out. */
export function k3CashFlowInput(report: unknown): K3CashFlowInput | null {
  const kfa = (report as { kassaflodesanalys?: unknown } | null)?.kassaflodesanalys
  if (!kfa) return null
  const statement = (kfa as { statement?: unknown }).statement
  if (isChapter7Statement(statement)) return k3CashFlowFromStatement(statement)
  return k3CashFlowFromSummary(kfa as CashFlowSummaryLike)
}

// ---- 4. förvaltningsberättelse items ----------------------------------------

/**
 * The K3 3.7 items and other förvaltningsberättelse texts by fdr concept.
 * The disclosure matrix produces them; until it is on main there are none
 * beyond verksamheten and väsentliga händelser.
 */
export function k3ForvaltningsberattelseItems(report: unknown): Array<{ concept: string | null; heading: string; text: string }> {
  const items = (report as { k3_forvaltningsberattelse?: unknown } | null)?.k3_forvaltningsberattelse
  if (!Array.isArray(items)) return []
  return items
    .filter((item): item is { concept: string | null; heading: string; text: string } =>
      Boolean(item) && typeof (item as { text?: unknown }).text === 'string' && typeof (item as { heading?: unknown }).heading === 'string',
    )
    .map((item) => ({ concept: item.concept ?? null, heading: item.heading, text: item.text }))
}
