/**
 * The specification of changes in equity (ÅRL 6 kap. 2 § andra stycket,
 * K3 punkt 6.3 a-e): ONE builder, from the real 20xx ledger movements.
 *
 * Replaces two derivations that guessed the year's movements from closing
 * balances (buildK3EquityChangesStatement: bundet growth was "nyemission",
 * any other shortfall "utdelning"; the K2 iXBRL input: every fall in
 * balanserat resultat beyond last year's result was "utdelning"). Each
 * verifikat that touches an equity account is classified by the accounts it
 * moves and by its counter-accounts, so an aktieägartillskott, an omföring
 * or a correction booked against balanserat resultat is shown as what it is.
 *
 * The result is keyed by concept (the BR post: 'Aktiekapital',
 * 'BalanseratResultat', ...) and by movement kind (EquityMovementKind), never
 * by label or account, so other documents can map it:
 *   - the K2 and K3 iXBRL equity tables, per post and kind
 *     (lib/bokslut/ixbrl/k3-adapters.ts, document/equity-table.ts map
 *     concept x kind to the taxonomy), and the K2 document's collapsed table
 *     for the inputs that cannot print that one (k2EquityTableInput below);
 *   - ekonomisk förening insatser (P4: insatser_inbetalda/_aterbetalda on the
 *     Medlemsinsatser/Forlagsinsatser posts of the förening post table).
 *
 * Every amount is in öre, credit-positive (an increase of equity is > 0).
 * The closing of every post is the balance sheet's own figure for that post:
 * equitySpecificationIssues fails loudly when the two drift apart.
 *
 * What the ledger cannot tell: there is no tag in the books for an error
 * correction or a retroactive change of accounting principle booked against
 * equity (K3 6.3 b), and no tag for most other direct-to-equity items. Such a
 * verifikat lands in 'ovrigt' with a warning naming it; the user classifies it
 * (overrides, keyed by journal entry id), and nothing is guessed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntriesWithAccountLines, fetchEntryLines } from '@/lib/bookkeeping/entry-lines'
import { isZeroOre, roundOre, sumOre } from '@/lib/money'
import {
  K2_BR_LAYOUT,
  K2_BR_MAPPINGS,
  K2_BR_MAPPINGS_EKONOMISK_FORENING,
  type K2LegalForm,
  type K2MappingResult,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import { roundWhole } from '@/lib/bokslut/ixbrl/whole-kronor'
import type { TrialBalanceRow } from '@/types'
import type { EgetKapitalForandring } from '@/lib/bokslut/ixbrl/types'

// ─── Kinds ─────────────────────────────────────────────────────────────────

export {
  EQUITY_MOVEMENT_KINDS,
  USER_CLASSIFIABLE_KINDS,
  equityMovementLabel,
  type EquityMovementKind,
  type EquityMovementKindInfo,
} from './equity-kinds'
import { EQUITY_MOVEMENT_KINDS, equityMovementLabel, type EquityMovementKind } from './equity-kinds'

// ─── Posts ─────────────────────────────────────────────────────────────────

export interface AccountRange {
  start: string
  end: string
}

/**
 * One equity post of the balance sheet. `concept` is the BR concept the post
 * is mapped to (the key the closing ties to); `ranges` are its BAS accounts.
 */
export interface EquityPostDefinition {
  concept: string
  label: string
  bound: boolean
  ranges: readonly AccountRange[]
}

/** Labels of the equity posts, as the balance sheet prints them. */
export const EQUITY_POST_LABELS: Record<string, string> = {
  Aktiekapital: 'Aktiekapital',
  EjRegistreratAktiekapital: 'Ej registrerat aktiekapital',
  Medlemsinsatser: 'Medlemsinsatser',
  Forlagsinsatser: 'Förlagsinsatser',
  OverkursfondBunden: 'Bunden överkursfond',
  Uppskrivningsfond: 'Uppskrivningsfond',
  Reservfond: 'Reservfond',
  FondUtvecklingsutgifter: 'Fond för utvecklingsutgifter',
  Overkursfond: 'Fri överkursfond',
  FondVerkligtVarde: 'Fond för verkligt värde',
  BalanseratResultat: 'Balanserat resultat',
  AretsResultatEgetKapital: 'Årets resultat',
}

const RESULT_CONCEPT = 'AretsResultatEgetKapital'
const RETAINED_CONCEPT = 'BalanseratResultat'

/** The K2 balance sheet's equity sections (bundet and fritt), from the one layout the mapper sums. */
function k2EquitySections(): { bound: readonly string[]; free: readonly string[] } {
  const heading = K2_BR_LAYOUT.equityLiabilities.find(
    (entry): entry is Extract<(typeof K2_BR_LAYOUT.equityLiabilities)[number], { sections: unknown }> =>
      'sections' in entry && entry.key === 'egetKapital',
  )
  const bound = heading?.sections.find((s) => s.key === 'bundetEgetKapital')?.concepts ?? []
  const free = heading?.sections.find((s) => s.key === 'frittEgetKapital')?.concepts ?? []
  return { bound, free }
}

/** The mapper's BR table per equity layout (k2-mapper.ts brMappingsFor). */
const K2_BR_MAPPINGS_BY_FORM: Record<K2LegalForm, typeof K2_BR_MAPPINGS> = {
  aktiebolag: K2_BR_MAPPINGS,
  ekonomisk_forening: K2_BR_MAPPINGS_EKONOMISK_FORENING,
}

/**
 * The equity posts of the K2 balance sheet for a legal form: the same
 * concepts and BAS ranges mapTrialBalancesToK2 reads, so each post's closing
 * is the balance sheet's figure by construction. The K3 presentation layer
 * passes its own list (own posts for 2089 and 2096).
 */
export function k2EquityPosts(legalForm: K2LegalForm): EquityPostDefinition[] {
  const { bound, free } = k2EquitySections()
  const mappings = K2_BR_MAPPINGS_BY_FORM[legalForm]
  const posts: EquityPostDefinition[] = []
  for (const concept of [...bound, ...free]) {
    const mapping = mappings.find((m) => m.concept === concept)
    if (!mapping) continue
    posts.push({
      concept,
      label: EQUITY_POST_LABELS[concept] ?? concept,
      bound: bound.includes(concept),
      ranges: mapping.ranges.map((range) => ({ start: range.start, end: range.end })),
    })
  }
  return posts
}

function inRanges(account: string, ranges: readonly AccountRange[]): boolean {
  return ranges.some((range) => account >= range.start && account <= range.end)
}

/** Every four-digit account the posts cover (the RPC filters by exact numbers). */
export function equityAccountNumbers(posts: readonly EquityPostDefinition[]): string[] {
  const accounts: string[] = []
  for (const post of posts) {
    for (const range of post.ranges) {
      for (let n = Number(range.start); n <= Number(range.end); n++) accounts.push(String(n))
    }
  }
  return [...new Set(accounts)].sort()
}

// ─── Inputs ────────────────────────────────────────────────────────────────

/** A verifikat that touches equity, with every one of its lines. */
export interface EquityEntry {
  id: string
  voucher: string | null
  entry_date: string
  description: string | null
  source_type: string | null
  reverses_id: string | null
  lines: Array<{ account_number: string; debit: number; credit: number }>
}

export interface EquityYearInput {
  fiscal_period_id: string
  name: string
  period_start: string
  period_end: string
  /** The year's FULL trial balance (closing entry included): IB and UB per account. */
  tbRows: ReadonlyArray<Pick<TrialBalanceRow, 'account_number' | 'opening_debit' | 'opening_credit' | 'closing_debit' | 'closing_credit'>>
  /** The year's verifikat that touch equity, the ingående balans verifikat excluded. */
  entries: readonly EquityEntry[]
  /**
   * The balance sheet's closing per concept for this year (the mapping). When
   * the mapper presents something the books do not hold (a comparison year
   * never closed here: its result derived from the income statement), the
   * difference is shown as the year's result and an omföring, marked derived.
   */
  balanceSheetClosing?: Readonly<Record<string, number>>
}

/** The user's classification of a verifikat the ledger cannot classify, by journal entry id. */
export type EquityMovementOverrides = Readonly<Record<string, EquityMovementKind>>

// ─── Output ────────────────────────────────────────────────────────────────

export interface EquityPostYear {
  concept: string
  label: string
  bound: boolean
  opening: number
  /** Non-zero movements only, credit-positive. */
  movements: Partial<Record<EquityMovementKind, number>>
  closing: number
}

export interface UnclassifiedEquityEntry {
  journal_entry_id: string
  voucher: string | null
  entry_date: string
  description: string | null
  /** The verifikat's net effect on equity, credit-positive. */
  amount: number
  concepts: string[]
}

export interface EquitySpecificationYear {
  fiscal_period_id: string
  name: string
  period_start: string
  period_end: string
  posts: EquityPostYear[]
  totals: {
    opening: number
    movements: Partial<Record<EquityMovementKind, number>>
    closing: number
  }
  /** The year's result or an omföring was derived (the year was never closed in these books). */
  derived: boolean
  /** Verifikat in 'ovrigt': the user should classify them. */
  unclassified: UnclassifiedEquityEntry[]
  /** Verifikat the user classified (the overrides), so the choice can be seen
   *  and changed. Absent when there are none. */
  user_classified?: Array<UnclassifiedEquityEntry & { kind: EquityMovementKind }>
}

export interface EquitySpecification {
  /** Where the årsredovisning prints it (K3 3.10 allows both; default förvaltningsberättelsen). */
  placement: 'management_report' | 'separate_statement'
  current: EquitySpecificationYear
  /** The jämförelseår, when its trial balance and verifikat could be read. */
  previous: EquitySpecificationYear | null
  /** Kinds with a movement in either year, in presentation order. */
  kinds: EquityMovementKind[]
  /**
   * 'k2' on a report that prints the K2 taxonomy's row labels
   * (equityMovementLabel). Absent on a K3 report, and on a K2 report built
   * before those labels existed: a locked version keeps the row labels it
   * was signed with.
   */
  row_labels?: 'k2'
  warnings: string[]
  /** Where the books and the balance sheet disagree (empty when they tie). */
  integrity_issues: string[]
}

// ─── Classification ────────────────────────────────────────────────────────

type ConceptAmountsMap = Map<string, number>

function postOf(account: string, posts: readonly EquityPostDefinition[]): EquityPostDefinition | null {
  return posts.find((post) => inRanges(account, post.ranges)) ?? null
}

function accountClass(account: string): number {
  return Number(account[0])
}

/** BAS 2093 Erhållna aktieägartillskott: the account a tillskott is booked to. */
const SHAREHOLDER_CONTRIBUTION_ACCOUNTS: readonly AccountRange[] = [{ start: '2093', end: '2093' }]
/** BAS 2094 Egna aktier: a purchase of own shares is a value transfer to owners. */
const OWN_SHARES_ACCOUNTS: readonly AccountRange[] = [{ start: '2094', end: '2094' }]
/** BAS 2092 Mottagna/lämnade koncernbidrag (equity-booked, pre-K3 practice). */
const GROUP_CONTRIBUTION_ACCOUNTS: readonly AccountRange[] = [{ start: '2092', end: '2092' }]
/** BAS 2898 Outtagen vinstutdelning: the dividend liability. */
const DIVIDEND_LIABILITY_ACCOUNTS: readonly AccountRange[] = [{ start: '2898', end: '2898' }]
/** Where a paid dividend or a repaid contribution goes: bank, the dividend liability, the shareholder loan. */
const OWNER_SETTLEMENT_ACCOUNTS: readonly AccountRange[] = [
  { start: '1900', end: '1999' },
  { start: '2890', end: '2899' },
]
/** Anläggningstillgångar: the counter side of an uppskrivning. */
const FIXED_ASSET_ACCOUNTS: readonly AccountRange[] = [{ start: '1000', end: '1399' }]

const SHARE_ISSUE_CONCEPTS = new Set(['Aktiekapital', 'EjRegistreratAktiekapital', 'OverkursfondBunden', 'Overkursfond'])
const MEMBER_CAPITAL_CONCEPTS = new Set(['Medlemsinsatser', 'Forlagsinsatser'])

interface EntryAnalysis {
  /** Net credit per concept on the equity lines. */
  byConcept: ConceptAmountsMap
  /** Net credit per equity account. */
  byAccount: Map<string, number>
  /** The non-equity lines. */
  counter: Array<{ account_number: string; net: number }>
  /** Net effect on equity (credit-positive). */
  equityNet: number
}

function analyse(entry: EquityEntry, posts: readonly EquityPostDefinition[]): EntryAnalysis | null {
  const byConcept: ConceptAmountsMap = new Map()
  const byAccount = new Map<string, number>()
  const counter: Array<{ account_number: string; net: number }> = []
  for (const line of entry.lines) {
    const net = roundOre((Number(line.credit) || 0) - (Number(line.debit) || 0))
    const post = postOf(line.account_number, posts)
    if (post) {
      byConcept.set(post.concept, roundOre((byConcept.get(post.concept) ?? 0) + net))
      byAccount.set(line.account_number, roundOre((byAccount.get(line.account_number) ?? 0) + net))
    } else {
      counter.push({ account_number: line.account_number, net })
    }
  }
  if (byConcept.size === 0) return null
  const equityNet = sumOre([...byConcept.values()])
  return { byConcept, byAccount, counter, equityNet }
}

/** The kind of a purely internal transfer between equity posts. */
function internalKind(byConcept: ConceptAmountsMap): EquityMovementKind {
  const moved = [...byConcept.entries()].filter(([, amount]) => !isZeroOre(amount))
  const result = byConcept.get(RESULT_CONCEPT) ?? 0
  // Last year's result leaves Årets resultat for the free posts: the
  // disposition the stämma decided (balanseras i ny räkning).
  if (!isZeroOre(result) && moved.every(([concept]) => concept === RESULT_CONCEPT || concept === RETAINED_CONCEPT || concept === 'Overkursfond')) {
    return 'resultatdisposition'
  }
  // Share capital credited from other equity: a fondemission.
  if ((byConcept.get('Aktiekapital') ?? 0) > 0 && moved.every(([concept, amount]) => concept === 'Aktiekapital' || amount < 0)) {
    return 'fondemission'
  }
  return 'omforing'
}

function accountsMatch(analysis: EntryAnalysis, ranges: readonly AccountRange[], sign: 1 | -1): boolean {
  return [...analysis.byAccount.entries()].some(([account, amount]) => inRanges(account, ranges) && Math.sign(amount) === sign && !isZeroOre(amount))
}

/** The kind of the part of a verifikat that moves equity against other accounts. */
function externalKind(analysis: EntryAnalysis): EquityMovementKind {
  const counterAccounts = analysis.counter.filter((line) => !isZeroOre(line.net)).map((line) => line.account_number)
  const counterOnlyIn = (ranges: readonly AccountRange[]) =>
    counterAccounts.length > 0 && counterAccounts.every((account) => inRanges(account, ranges))
  // The year's result: the result accounts (class 3-8, the 899x omföring
  // included) closed against Årets resultat.
  if (
    counterAccounts.length > 0
    && counterAccounts.every((account) => accountClass(account) >= 3 && accountClass(account) <= 8)
    && [...analysis.byConcept.keys()].every((concept) => concept === RESULT_CONCEPT)
  ) {
    return 'arets_resultat'
  }
  if (accountsMatch(analysis, GROUP_CONTRIBUTION_ACCOUNTS, 1) || accountsMatch(analysis, GROUP_CONTRIBUTION_ACCOUNTS, -1)) {
    return 'ovriga_direkt_mot_eget_kapital'
  }
  if (analysis.byConcept.has('FondVerkligtVarde')) return 'verkligt_varde'
  if (analysis.equityNet > 0) {
    if (accountsMatch(analysis, SHAREHOLDER_CONTRIBUTION_ACCOUNTS, 1)) return 'aktieagartillskott'
    if ([...analysis.byConcept.entries()].some(([concept, amount]) => MEMBER_CAPITAL_CONCEPTS.has(concept) && amount > 0)) {
      return 'insatser_inbetalda'
    }
    if ([...analysis.byConcept.entries()].some(([concept, amount]) => SHARE_ISSUE_CONCEPTS.has(concept) && amount > 0)) {
      return 'nyemission'
    }
    if ((analysis.byConcept.get('Uppskrivningsfond') ?? 0) > 0 && counterOnlyIn(FIXED_ASSET_ACCOUNTS)) return 'uppskrivning'
    return 'ovrigt'
  }
  // Equity decreases.
  if (counterAccounts.some((account) => inRanges(account, DIVIDEND_LIABILITY_ACCOUNTS))) return 'utdelning'
  if (accountsMatch(analysis, SHAREHOLDER_CONTRIBUTION_ACCOUNTS, -1) && counterOnlyIn(OWNER_SETTLEMENT_ACCOUNTS)) {
    return 'aterbetalt_tillskott'
  }
  if ([...analysis.byConcept.entries()].some(([concept, amount]) => MEMBER_CAPITAL_CONCEPTS.has(concept) && amount < 0)) {
    return 'insatser_aterbetalda'
  }
  if (accountsMatch(analysis, OWN_SHARES_ACCOUNTS, -1)) return 'andra_vardeoverforingar'
  if ((analysis.byConcept.get('Uppskrivningsfond') ?? 0) < 0 && counterOnlyIn(FIXED_ASSET_ACCOUNTS)) return 'uppskrivning'
  // Free equity paid out to the owner (bank, the dividend liability or the
  // shareholder loan): a dividend paid without passing 2898.
  const freeOnly = [...analysis.byConcept.entries()].every(
    ([concept, amount]) => isZeroOre(amount) || concept === RETAINED_CONCEPT || concept === RESULT_CONCEPT || concept === 'Overkursfond',
  )
  if (freeOnly && counterOnlyIn(OWNER_SETTLEMENT_ACCOUNTS)) return 'utdelning'
  return 'ovrigt'
}

/**
 * Split a verifikat into movements per concept and kind. The part that moves
 * equity against other accounts (equityNet) is attributed to the posts that
 * moved in that direction, largest first; the rest is an internal transfer.
 */
function classifyEntry(
  analysis: EntryAnalysis,
  forced: EquityMovementKind | null,
): Array<{ concept: string; kind: EquityMovementKind; amount: number }> {
  const out: Array<{ concept: string; kind: EquityMovementKind; amount: number }> = []
  const remaining = new Map(analysis.byConcept)
  if (!isZeroOre(analysis.equityNet)) {
    const kind = forced ?? externalKind(analysis)
    const direction = Math.sign(analysis.equityNet)
    let left = Math.abs(analysis.equityNet)
    const candidates = [...remaining.entries()]
      .filter(([, amount]) => Math.sign(amount) === direction)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    for (const [concept, amount] of candidates) {
      if (left <= 0) break
      const take = roundOre(Math.min(Math.abs(amount), left))
      out.push({ concept, kind, amount: roundOre(direction * take) })
      remaining.set(concept, roundOre(amount - direction * take))
      left = roundOre(left - take)
    }
  }
  const internal = new Map([...remaining.entries()].filter(([, amount]) => !isZeroOre(amount)))
  if (internal.size > 0) {
    const kind = forced && isZeroOre(analysis.equityNet) ? forced : internalKind(internal)
    for (const [concept, amount] of internal) out.push({ concept, kind, amount })
  }
  return out
}

// ─── Builder ───────────────────────────────────────────────────────────────

function netCredit(row: { debit?: number; credit?: number }): number {
  return roundOre((Number(row.credit) || 0) - (Number(row.debit) || 0))
}

function addMovement(target: Partial<Record<EquityMovementKind, number>>, kind: EquityMovementKind, amount: number) {
  const next = roundOre((target[kind] ?? 0) + amount)
  if (isZeroOre(next)) delete target[kind]
  else target[kind] = next
}

/**
 * One year of the specification, pure. Opening and closing per post from the
 * trial balance; movements from the verifikat; whatever the verifikat do not
 * explain (it should be nothing) lands in 'ovrigt' with a warning.
 */
export function computeEquitySpecificationYear(
  posts: readonly EquityPostDefinition[],
  input: EquityYearInput,
  overrides: EquityMovementOverrides = {},
  warnings: string[] = [],
): EquitySpecificationYear {
  const opening = new Map<string, number>()
  const booked = new Map<string, number>()
  for (const row of input.tbRows) {
    const post = postOf(row.account_number, posts)
    if (!post) continue
    opening.set(post.concept, roundOre((opening.get(post.concept) ?? 0) + netCredit({ debit: row.opening_debit, credit: row.opening_credit })))
    booked.set(post.concept, roundOre((booked.get(post.concept) ?? 0) + netCredit({ debit: row.closing_debit, credit: row.closing_credit })))
  }

  const movements = new Map<string, Partial<Record<EquityMovementKind, number>>>(posts.map((p) => [p.concept, {}]))
  const kindByEntry = new Map<string, EquityMovementKind>()
  const unclassified: UnclassifiedEquityEntry[] = []
  const userClassified: Array<UnclassifiedEquityEntry & { kind: EquityMovementKind }> = []
  // Originals before their storno, so a reversal takes the kind of what it reverses.
  const ordered = [...input.entries].sort((a, b) =>
    a.reverses_id && !b.reverses_id ? 1 : !a.reverses_id && b.reverses_id ? -1 : a.entry_date.localeCompare(b.entry_date),
  )
  for (const entry of ordered) {
    const analysis = analyse(entry, posts)
    if (!analysis) continue
    const forced = overrides[entry.id] ?? (entry.reverses_id ? kindByEntry.get(entry.reverses_id) ?? null : null)
    const parts = classifyEntry(analysis, forced)
    for (const part of parts) addMovement(movements.get(part.concept)!, part.kind, part.amount)
    const userKind = overrides[entry.id]
    if (userKind) {
      userClassified.push({
        journal_entry_id: entry.id,
        voucher: entry.voucher,
        entry_date: entry.entry_date,
        description: entry.description,
        amount: analysis.equityNet,
        concepts: [...analysis.byConcept.keys()],
        kind: userKind,
      })
    }
    const externalPart = parts.find((part) => part.kind !== 'resultatdisposition' && part.kind !== 'omforing' && part.kind !== 'fondemission')
    kindByEntry.set(entry.id, externalPart?.kind ?? parts[0]?.kind ?? 'omforing')
    if (parts.some((part) => part.kind === 'ovrigt')) {
      unclassified.push({
        journal_entry_id: entry.id,
        voucher: entry.voucher,
        entry_date: entry.entry_date,
        description: entry.description,
        amount: analysis.equityNet,
        concepts: [...analysis.byConcept.keys()],
      })
    }
  }

  // What the balance sheet presents beyond the books (a comparison year never
  // closed here): the total is the year's result, shown on Årets resultat;
  // a shift between posts is an omföring against Årets resultat.
  let derived = false
  if (input.balanceSheetClosing) {
    let totalDiff = 0
    for (const post of posts) {
      const presented = input.balanceSheetClosing[post.concept]
      if (presented === undefined) continue
      const diff = roundOre(presented - (booked.get(post.concept) ?? 0))
      // Under a krona is the balance sheet's rounding to whole kronor, which
      // presentEquitySpecificationYear absorbs; only a real gap is derived.
      if (Math.abs(diff) < 1) continue
      derived = true
      totalDiff = roundOre(totalDiff + diff)
      if (post.concept !== RESULT_CONCEPT) {
        addMovement(movements.get(post.concept)!, 'omforing', diff)
        addMovement(movements.get(RESULT_CONCEPT) ?? {}, 'omforing', -diff)
      }
      booked.set(post.concept, presented)
    }
    if (derived && movements.has(RESULT_CONCEPT)) addMovement(movements.get(RESULT_CONCEPT)!, 'arets_resultat', totalDiff)
  }

  const postYears: EquityPostYear[] = []
  for (const post of posts) {
    const postOpening = opening.get(post.concept) ?? 0
    const closing = booked.get(post.concept) ?? 0
    const postMovements = movements.get(post.concept) ?? {}
    const explained = sumOre(Object.values(postMovements) as number[])
    const residual = roundOre(closing - postOpening - explained)
    if (!isZeroOre(residual)) {
      addMovement(postMovements, 'ovrigt', residual)
      warnings.push(
        `${post.label} (${input.name}): ${formatKr(residual)} av årets förändring kunde inte knytas till något verifikat och visas som Övriga förändringar. Kontrollera bokföringen av eget kapital.`,
      )
    }
    if (isZeroOre(postOpening) && isZeroOre(closing) && Object.keys(postMovements).length === 0) continue
    postYears.push({
      concept: post.concept,
      label: post.label,
      bound: post.bound,
      opening: postOpening,
      movements: postMovements,
      closing,
    })
  }

  const totalMovements: Partial<Record<EquityMovementKind, number>> = {}
  for (const post of postYears) {
    for (const [kind, amount] of Object.entries(post.movements) as Array<[EquityMovementKind, number]>) {
      addMovement(totalMovements, kind, amount)
    }
  }
  for (const entry of unclassified) {
    warnings.push(
      `Verifikat ${entry.voucher ?? entry.journal_entry_id} (${entry.entry_date}) ändrar eget kapital med ${formatKr(entry.amount)} mot konton som inte visar vad det är för förändring. Det visas som Övriga förändringar: ange om det är en rättelse av fel, en ändrad redovisningsprincip, en transaktion med ägarna eller något annat.`,
    )
  }
  return {
    fiscal_period_id: input.fiscal_period_id,
    name: input.name,
    period_start: input.period_start,
    period_end: input.period_end,
    posts: postYears,
    totals: {
      opening: sumOre(postYears.map((p) => p.opening)),
      movements: totalMovements,
      closing: sumOre(postYears.map((p) => p.closing)),
    },
    derived,
    unclassified,
    ...(userClassified.length > 0 ? { user_classified: userClassified } : {}),
  }
}

/** Öre-rounded, with -0 read as 0 (JSON and the iXBRL writer keep the sign of a negative zero). */
function ore(n: number): number {
  const rounded = roundOre(n)
  return rounded === 0 ? 0 : rounded
}

function formatKr(amount: number): string {
  return `${Math.round(amount).toLocaleString('sv-SE')} kr`
}

/** The balance sheet the specification ties to, as the årsredovisning presents it (whole kronor). */
export type EquityBalanceSheet = Pick<K2MappingResult, 'br' | 'totals'>

export interface BuildEquitySpecificationInput {
  posts: readonly EquityPostDefinition[]
  current: EquityYearInput
  previous: EquityYearInput | null
  balanceSheet: EquityBalanceSheet
  overrides?: EquityMovementOverrides
  placement?: EquitySpecification['placement']
  rowLabels?: EquitySpecification['row_labels']
}

/**
 * Whole kronor as the balance sheet rounds them (whole-kronor.ts: a half
 * away from zero, -0 read as 0), so a figure and its negative round alike:
 * what leaves one post in a transfer is what reaches the other, and the
 * year's result is the balance sheet's.
 */
const kr = roundWhole

/**
 * The exact (öre) year as the årsredovisning prints it, in whole kronor: each
 * post closes on the balance sheet's own figure and opens on last year's
 * (the comparison column), the movements rounded so the column ties. A
 * rounding difference goes to the largest movement; a real gap (the books
 * do not open on last year's close) is an 'ovrigt' row and a warning.
 */
function presentEquitySpecificationYear(
  exact: EquitySpecificationYear,
  posts: readonly EquityPostDefinition[],
  closingOf: (concept: string) => number | null,
  openingOf: ((concept: string) => number | null) | null,
  warnings: string[],
): EquitySpecificationYear {
  const rows = posts.map((post) => {
    const exactPost = exact.posts.find((p) => p.concept === post.concept)
    const closing = closingOf(post.concept) ?? kr(exactPost?.closing ?? 0)
    const booksOpening = kr(exactPost?.opening ?? 0)
    const opening = openingOf ? openingOf(post.concept) ?? booksOpening : booksOpening
    const movements: Partial<Record<EquityMovementKind, number>> = {}
    for (const [kind, amount] of Object.entries(exactPost?.movements ?? {}) as Array<[EquityMovementKind, number]>) {
      const rounded = kr(amount)
      if (rounded !== 0) movements[kind] = rounded
    }
    return { post, closing, opening, booksOpening, movements }
  })

  // The year's ingående balans may already carry last year's result moved
  // to balanserat resultat (an IB written that way, or imported so): the
  // books then open on other posts than last year's balance sheet closed
  // on, with the same total. That reallocation is the disposition the
  // stämma decided, shown as one; a gap that changes the total is not, and
  // is left to the warning below.
  if (openingOf) {
    const gaps = new Map(rows.map((row) => [row.post.concept, row.booksOpening - row.opening]))
    const gapTotal = [...gaps.values()].reduce((a, b) => a + b, 0)
    const material = [...gaps.values()].some((gap) => Math.abs(gap) > posts.length)
    if (material && Math.abs(gapTotal) <= posts.length) {
      const kind = internalKind(new Map([...gaps.entries()].filter(([, gap]) => gap !== 0)))
      for (const row of rows) {
        const gap = gaps.get(row.post.concept) ?? 0
        if (gap === 0) continue
        row.movements[kind] = kr((row.movements[kind] ?? 0) + gap)
        if (row.movements[kind] === 0) delete row.movements[kind]
      }
    }
  }

  const presented: EquityPostYear[] = []
  for (const row of rows) {
    const { post, closing, movements } = row
    let { opening } = row
    const residual = kr(closing - opening - (Object.values(movements) as number[]).reduce((a, b) => a + b, 0))
    if (residual !== 0) {
      const kinds = Object.keys(movements) as EquityMovementKind[]
      if (kinds.length > 0 && Math.abs(residual) <= kinds.length + 1) {
        // Rounding to whole kronor: the largest movement takes it.
        const largest = kinds.reduce((a, b) => (Math.abs(movements[b]!) > Math.abs(movements[a]!) ? b : a))
        movements[largest] = kr(movements[largest]! + residual)
        if (movements[largest] === 0) delete movements[largest]
      } else if (!openingOf && Math.abs(residual) <= 1) {
        // Rounding with nothing moving and no comparison column to tie the
        // opening to: the opening takes it.
        opening = kr(opening + residual)
      } else {
        movements.ovrigt = kr((movements.ovrigt ?? 0) + residual)
        if (movements.ovrigt === 0) delete movements.ovrigt
        if (Math.abs(residual) > 1) {
          warnings.push(
            `${post.label} (${exact.name}): ingående balans ${formatKr(opening)} och årets bokförda förändringar summerar inte till balansräkningens ${formatKr(closing)}. Skillnaden ${formatKr(residual)} visas som Övriga förändringar: kontrollera att året öppnar på föregående års utgående balans.`,
          )
        }
      }
    }
    if (opening === 0 && closing === 0 && Object.keys(movements).length === 0) continue
    presented.push({ concept: post.concept, label: post.label, bound: post.bound, opening, movements, closing })
  }
  const totalMovements: Partial<Record<EquityMovementKind, number>> = {}
  for (const post of presented) {
    for (const [kind, amount] of Object.entries(post.movements) as Array<[EquityMovementKind, number]>) {
      const next = kr((totalMovements[kind] ?? 0) + amount)
      if (next === 0) delete totalMovements[kind]
      else totalMovements[kind] = next
    }
  }
  return {
    ...exact,
    posts: presented,
    totals: {
      opening: presented.reduce((sum, p) => sum + p.opening, 0),
      movements: totalMovements,
      closing: presented.reduce((sum, p) => sum + p.closing, 0),
    },
    unclassified: exact.unclassified.map((entry) => ({ ...entry, amount: kr(entry.amount) })),
    ...(exact.user_classified
      ? { user_classified: exact.user_classified.map((entry) => ({ ...entry, amount: kr(entry.amount) })) }
      : {}),
  }
}

/**
 * Where the books (exact, öre) and the balance sheet disagree by more than
 * its rounding: a post by more than a krona, eget kapital by more than a
 * krona per post. Any entry blocks the version (AR-EQUITY-SPECIFICATION-MISMATCH).
 */
function exactIssues(
  exact: EquitySpecificationYear,
  posts: readonly EquityPostDefinition[],
  balanceSheet: EquityBalanceSheet,
  field: 'current' | 'previous',
): string[] {
  const issues: string[] = []
  for (const post of posts) {
    const presented = balanceSheet.br[post.concept]?.[field]
    if (presented === null || presented === undefined) continue
    const books = exact.posts.find((p) => p.concept === post.concept)?.closing ?? 0
    if (Math.abs(books - presented) > 1) {
      issues.push(`${post.label} ${exact.name}: bokföringen ${formatKr(books)}, balansräkningen ${formatKr(presented)}.`)
    }
  }
  const equity = balanceSheet.totals.egetKapital[field]
  if (equity !== null && equity !== undefined && Math.abs(exact.totals.closing - equity) > posts.length) {
    issues.push(`Eget kapital ${exact.name}: bokföringen ${formatKr(exact.totals.closing)}, balansräkningen ${formatKr(equity)}.`)
  }
  return issues
}

/**
 * Both years, pure: the books' movements, presented in whole kronor against
 * the balance sheet. `integrity_issues` lists every disagreement between the
 * books and the balance sheet (equitySpecificationIssues adds the presented
 * ones); completeness blocks the version on any.
 */
export function buildEquitySpecification(input: BuildEquitySpecificationInput): EquitySpecification {
  const warnings: string[] = []
  const overrides = input.overrides ?? {}
  const { balanceSheet } = input
  const hasPreviousColumn = input.previous !== null && balanceSheet.totals.egetKapital.previous !== null
  const exactCurrent = computeEquitySpecificationYear(input.posts, input.current, overrides, warnings)
  const exactPrevious = input.previous
    ? computeEquitySpecificationYear(
        input.posts,
        {
          ...input.previous,
          balanceSheetClosing: Object.fromEntries(
            input.posts.flatMap((post) => {
              const value = balanceSheet.br[post.concept]?.previous
              return value === null || value === undefined ? [] : [[post.concept, value]]
            }),
          ),
        },
        overrides,
        warnings,
      )
    : null
  const integrityIssues = [
    ...exactIssues(exactCurrent, input.posts, balanceSheet, 'current'),
    ...(exactPrevious && hasPreviousColumn ? exactIssues(exactPrevious, input.posts, balanceSheet, 'previous') : []),
  ]
  const brValue = (field: 'current' | 'previous') => (concept: string): number | null => {
    const value = balanceSheet.br[concept]?.[field]
    return value === null || value === undefined ? null : kr(value)
  }
  const previous = exactPrevious
    ? presentEquitySpecificationYear(
        exactPrevious,
        input.posts,
        hasPreviousColumn ? brValue('previous') : () => null,
        null,
        warnings,
      )
    : null
  const current = presentEquitySpecificationYear(
    exactCurrent,
    input.posts,
    brValue('current'),
    hasPreviousColumn ? brValue('previous') : null,
    warnings,
  )
  const present = new Set<EquityMovementKind>()
  for (const year of [current, previous]) {
    if (!year) continue
    for (const post of year.posts) for (const kind of Object.keys(post.movements) as EquityMovementKind[]) present.add(kind)
  }
  return {
    placement: input.placement ?? 'management_report',
    current,
    previous,
    kinds: EQUITY_MOVEMENT_KINDS.map((info) => info.kind).filter((kind) => present.has(kind)),
    ...(input.rowLabels ? { row_labels: input.rowLabels } : {}),
    warnings,
    integrity_issues: integrityIssues,
  }
}

// ─── Integrity ─────────────────────────────────────────────────────────────

/**
 * Where the specification and the balance sheet disagree: the books against
 * the balance sheet (integrity_issues, computed when it was built), then the
 * presented figures: every post's closing against the post, the total
 * against eget kapital, and each column from opening to closing. An empty
 * list is the only acceptable answer; completeness turns any entry into the
 * blocking AR-EQUITY-SPECIFICATION-MISMATCH.
 */
export function equitySpecificationIssues(
  spec: EquitySpecification,
  balanceSheet: EquityBalanceSheet,
): string[] {
  const issues: string[] = [...(spec.integrity_issues ?? [])]
  const check = (year: EquitySpecificationYear, field: 'current' | 'previous') => {
    for (const post of year.posts) {
      const presented = balanceSheet.br[post.concept]?.[field]
      if (presented === null || presented === undefined) continue
      if (kr(presented) !== post.closing) {
        issues.push(`${post.label} ${year.name}: specifikationen ${formatKr(post.closing)}, balansräkningen ${formatKr(presented)}.`)
      }
    }
    const equity = balanceSheet.totals.egetKapital[field]
    if (equity !== null && equity !== undefined && kr(equity) !== year.totals.closing) {
      issues.push(`Eget kapital ${year.name}: specifikationen ${formatKr(year.totals.closing)}, balansräkningen ${formatKr(equity)}.`)
    }
    for (const post of year.posts) {
      const explained = post.opening + (Object.values(post.movements) as number[]).reduce((a, b) => a + b, 0)
      if (explained !== post.closing) {
        issues.push(`${post.label} ${year.name}: ingående balans och årets förändringar summerar inte till utgående balans.`)
      }
    }
  }
  check(spec.current, 'current')
  if (spec.previous && balanceSheet.totals.egetKapital.previous !== null) check(spec.previous, 'previous')
  return issues
}

// ─── Presentation ──────────────────────────────────────────────────────────

export interface EquityTableRow {
  key: 'opening' | 'closing' | EquityMovementKind
  label: string
  /** One cell per column, then the total. */
  cells: number[]
  total: number
  is_total: boolean
}

export interface EquityTable {
  year: string
  columns: Array<{ concept: string; label: string }>
  rows: EquityTableRow[]
}

/**
 * The year as a table: one column per post that holds anything, rows from
 * the opening balance through each kind to the closing balance. Shared by
 * the K2 and K3 PDFs and the in-app preview so they cannot differ; the row
 * labels are the regelverk's (equityMovementLabel).
 */
export function equitySpecificationTable(year: EquitySpecificationYear, framework: 'k2' | 'k3' = 'k3'): EquityTable {
  const columns = year.posts.map((post) => ({ concept: post.concept, label: post.label }))
  const rows: EquityTableRow[] = [
    {
      key: 'opening',
      label: 'Belopp vid årets ingång',
      cells: year.posts.map((post) => post.opening),
      total: year.totals.opening,
      is_total: true,
    },
  ]
  for (const info of EQUITY_MOVEMENT_KINDS) {
    const total = year.totals.movements[info.kind]
    const cells = year.posts.map((post) => post.movements[info.kind] ?? 0)
    if (total === undefined && cells.every((cell) => isZeroOre(cell))) continue
    rows.push({ key: info.kind, label: equityMovementLabel(info.kind, framework), cells, total: total ?? 0, is_total: false })
  }
  rows.push({
    key: 'closing',
    label: 'Belopp vid årets utgång',
    cells: year.posts.map((post) => post.closing),
    total: year.totals.closing,
    is_total: true,
  })
  return { year: year.name, columns, rows }
}

/**
 * The input of the K2 iXBRL document's collapsed equity table (types
 * EgetKapitalForandring), from the specification instead of balance
 * residuals. The document prints the specification per post where it can
 * (ixbrl/document/equity-table.ts); this table stays for an input that
 * cannot (k2-document.ts says which). It has columns
 * for Aktiekapital, Balanserat resultat and Årets resultat (the rest in one
 * untagged "Övriga poster" column) and rows for balansering, utdelning,
 * nyemission (the change in aktiekapital), an untagged "Övrig förändring" of
 * balanserat resultat and årets resultat:
 *   - balanserasINyRakning: everything that left Årets resultat other than
 *     the year's own result (last year's result disposed);
 *   - utdelning: the dividends of the year, as a positive amount;
 *   - ovrigForandringBalanserat: what else moved balanserat resultat
 *     (tillskott, omföringar, corrections), never called a dividend;
 *   - aretsResultatRorelse: the year's result.
 * IB is last year's closing as the balance sheet's comparison column shows
 * it (the iXBRL tags both with the same balans1 facts, which must be equal,
 * TA §2.7.3); without a comparison year it is this year's opening from the
 * trial balance, so a first year in Accounted with an imported IB no longer
 * reads its whole share capital as a nyemission. Balansering is what closes
 * the Årets resultat column, so that column ties even when the books break
 * balanskontinuitet (the specification warns about that separately).
 */
export function k2EquityTableInput(spec: EquitySpecification): EgetKapitalForandring {
  const year = spec.current
  const previous = spec.previous
  const post = (concept: string) => year.posts.find((p) => p.concept === concept)
  const ib = (concept: string) =>
    previous
      ? previous.posts.find((p) => p.concept === concept)?.closing ?? 0
      : post(concept)?.opening ?? 0
  const ibUb = (concept: string) => ({ ib: ib(concept), ub: post(concept)?.closing ?? 0 })
  const aktiekapital = ibUb('Aktiekapital')
  const balanserat = ibUb(RETAINED_CONCEPT)
  const aretsRes = ibUb(RESULT_CONCEPT)
  const totalt = { ib: previous ? previous.totals.closing : year.totals.opening, ub: year.totals.closing }
  const ovrigaPoster = {
    ib: ore(totalt.ib - aktiekapital.ib - balanserat.ib - aretsRes.ib),
    ub: ore(totalt.ub - aktiekapital.ub - balanserat.ub - aretsRes.ub),
  }
  const aretsResultatRorelse = ore(post(RESULT_CONCEPT)?.movements.arets_resultat ?? 0)
  const balanserasINyRakning = ore(aretsRes.ib - aretsRes.ub + aretsResultatRorelse)
  const utdelning = ore(-(year.totals.movements.utdelning ?? 0))
  const ovrigForandringBalanserat = ore(balanserat.ub - balanserat.ib - balanserasINyRakning + utdelning)
  return {
    aktiekapital,
    balanseratResultat: balanserat,
    aretsResultat: aretsRes,
    totalt,
    ovrigaPoster,
    balanserasINyRakning,
    utdelning,
    forandringAktiekapital: ore(aktiekapital.ub - aktiekapital.ib),
    ovrigForandringBalanserat,
    aretsResultatRorelse,
  }
}

// ─── Loading ───────────────────────────────────────────────────────────────

export interface EquityPeriodRef {
  id: string
  name: string
  period_start: string
  period_end: string
  opening_balance_entry_id: string | null
}

function voucherLabel(series: string | null | undefined, number: number | null | undefined): string | null {
  if (number === null || number === undefined) return null
  return `${series ?? ''}${number}`
}

/**
 * The year's posted (and reversed, with their storno) verifikat that touch
 * an equity account, each with every line, the ingående balans verifikat
 * left out as the trial balance leaves it out.
 */
export async function loadEquityEntries(
  supabase: SupabaseClient,
  companyId: string,
  period: EquityPeriodRef,
  accounts: readonly string[],
): Promise<EquityEntry[]> {
  const viaRpc = await fetchEntriesWithAccountLines(supabase, companyId, {
    start: period.period_start,
    end: period.period_end,
    accounts,
    statuses: ['posted', 'reversed'],
    allLines: true,
  })
  if (viaRpc) {
    return viaRpc
      .filter((entry) => entry.id !== period.opening_balance_entry_id)
      .map((entry) => ({
        id: entry.id,
        voucher: voucherLabel(entry.voucher_series, entry.voucher_number),
        entry_date: entry.entry_date,
        description: entry.description ?? null,
        source_type: entry.source_type,
        reverses_id: entry.reverses_id,
        lines: entry.lines.map((line) => ({
          account_number: line.account_number,
          debit: Number(line.debit_amount) || 0,
          credit: Number(line.credit_amount) || 0,
        })),
      }))
  }
  // The deploy window before get_entries_with_account_lines exists: the paged read.
  type Line = {
    journal_entry_id: string
    account_number: string
    debit_amount: number | null
    credit_amount: number | null
    journal_entries: {
      id: string
      voucher_series: string | null
      voucher_number: number | null
      entry_date: string
      description: string | null
      source_type: string | null
      reverses_id: string | null
    }
  }
  const lines = await fetchEntryLines<Line>({
    supabase,
    entryColumns: 'id, voucher_series, voucher_number, entry_date, description, source_type, reverses_id',
    lineColumns: 'journal_entry_id, account_number, debit_amount, credit_amount',
    filterEntries: (query) =>
      query
        .eq('company_id', companyId)
        .gte('entry_date', period.period_start)
        .lte('entry_date', period.period_end)
        .in('status', ['posted', 'reversed']),
  })
  const accountSet = new Set(accounts)
  const byEntry = new Map<string, EquityEntry>()
  for (const line of lines) {
    const parent = line.journal_entries
    if (!parent || parent.id === period.opening_balance_entry_id) continue
    let entry = byEntry.get(parent.id)
    if (!entry) {
      entry = {
        id: parent.id,
        voucher: voucherLabel(parent.voucher_series, parent.voucher_number),
        entry_date: parent.entry_date,
        description: parent.description,
        source_type: parent.source_type,
        reverses_id: parent.reverses_id,
        lines: [],
      }
      byEntry.set(parent.id, entry)
    }
    entry.lines.push({
      account_number: line.account_number,
      debit: Number(line.debit_amount) || 0,
      credit: Number(line.credit_amount) || 0,
    })
  }
  return [...byEntry.values()].filter((entry) => entry.lines.some((line) => accountSet.has(line.account_number)))
}

export interface ReportEquityYear {
  period: { id: string; name: string; period_start: string; period_end: string }
  /** The year's FULL trial balance (generateTrialBalance rows, opening balances included). */
  tbRows: EquityYearInput['tbRows']
}

/**
 * The specification for an årsredovisning: reads the verifikat of the year
 * (and of the comparison year) that touch equity and builds both years
 * against the balance sheet the report presents. The ingående balans
 * verifikat of each year is left out, as the trial balance leaves it out.
 */
export async function loadEquitySpecification(
  supabase: SupabaseClient,
  companyId: string,
  input: {
    posts: readonly EquityPostDefinition[]
    current: ReportEquityYear
    previous: ReportEquityYear | null
    balanceSheet: EquityBalanceSheet
    overrides?: EquityMovementOverrides
    placement?: EquitySpecification['placement']
    rowLabels?: EquitySpecification['row_labels']
  },
): Promise<EquitySpecification> {
  const accounts = equityAccountNumbers(input.posts)
  const years = [input.current, ...(input.previous ? [input.previous] : [])]
  const { data: obRows, error: obError } = await supabase
    .from('fiscal_periods')
    .select('id, opening_balance_entry_id')
    .eq('company_id', companyId)
    .in('id', years.map((year) => year.period.id))
  if (obError) throw new Error(`Failed to load the fiscal years' opening balance entries: ${obError.message}`)
  const obByPeriod = new Map(
    ((obRows ?? []) as Array<{ id: string; opening_balance_entry_id: string | null }>).map((row) => [
      row.id,
      row.opening_balance_entry_id,
    ]),
  )
  const [currentEntries, previousEntries] = await Promise.all(
    years.map((year) =>
      loadEquityEntries(
        supabase,
        companyId,
        { ...year.period, opening_balance_entry_id: obByPeriod.get(year.period.id) ?? null },
        accounts,
      ),
    ),
  )
  const toInput = (year: ReportEquityYear, entries: EquityEntry[]): EquityYearInput => ({
    fiscal_period_id: year.period.id,
    name: year.period.name,
    period_start: year.period.period_start,
    period_end: year.period.period_end,
    tbRows: year.tbRows,
    entries,
  })
  return buildEquitySpecification({
    posts: input.posts,
    current: toInput(input.current, currentEntries),
    previous: input.previous ? toInput(input.previous, previousEntries ?? []) : null,
    balanceSheet: input.balanceSheet,
    overrides: input.overrides,
    placement: input.placement,
    rowLabels: input.rowLabels,
  })
}
