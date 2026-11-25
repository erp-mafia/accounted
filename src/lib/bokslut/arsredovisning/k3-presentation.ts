/**
 * The K3 balance sheet: K3's own posts, laid over the K2 risbs mapping.
 *
 * The K2 mapper (lib/bokslut/ixbrl/k2-mapper.ts) folds several balances into
 * the nearest K2 post. K3 requires them as posts of their own:
 *   - uppskjuten skattefordran (BAS 1370), aktuell skattefordran (1640 and an
 *     overpaid 25xx) and uppskjuten skatteskuld (2240) "som egna poster"
 *     (K3 4.3 kommentar, 29.6, 29.20);
 *   - balanserade utgifter för utvecklingsarbeten och liknande arbeten
 *     (1010-1019), fond för utvecklingsutgifter (2089) and fond för verkligt
 *     värde (2096), posts of ÅRL bilaga 1 that K2 does not use;
 *   - övriga avsättningar för skatter (2250), the rest of "Avsättningar för
 *     skatter" (ÅRL bilaga 1, C 2).
 *
 * Each new post is carved out of the K2 post that held it: its amount (whole
 * kronor, from the trial balance) moves from the K2 concept to its own, so
 * every subtotal and the balance sheet total stay exactly the mapper's. The
 * K2 mapping itself is never changed, so the K2 document and the K2 iXBRL
 * are unaffected: only a K3 report runs through here.
 *
 * Concept keys are the K3 taxonomy names (se-gen-base 2021-10-31: K3 risbs),
 * so the K3 iXBRL (P3) tags them as they stand, including the taxonomy's own
 * spelling AktuellSkattefodran.
 */
import { roundOre, sumOre } from '@/lib/money'
import type { ConceptAmount, ConceptAmounts } from '@/lib/bokslut/ixbrl/types'
import { k2BrPostForAccount, type K2LegalForm, type K2MappingResult, type TrialBalanceRowLike } from '@/lib/bokslut/ixbrl/k2-mapper'
import { SIGN_RECLASSIFICATION_RULES, selectReclassifiedAccounts } from '@/lib/reports/sign-reclassification'
import { k2EquityPosts, type EquityPostDefinition } from './equity-specification'

export type K3Presentation = 'k3'

/** A K2 mapping presented with K3's own posts (statement-rows reads `presentation`). */
export type K3MappingResult = K2MappingResult & { presentation: K3Presentation }

interface Range {
  start: string
  end: string
}

/** One K3 post carved out of a K2 post. */
export interface K3Split {
  concept: string
  /** The K2 concept the balance sits in today. */
  from: string
  orientation: 'debit' | 'credit'
  ranges: readonly Range[]
}

/** The K3 posts that come straight from BAS ranges, in balance sheet order. */
export const K3_SPLITS: readonly K3Split[] = [
  {
    concept: 'BalanseradeUtgifterUtvecklingsarbetenLiknandeArbeten',
    from: 'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter',
    orientation: 'debit',
    ranges: [{ start: '1010', end: '1019' }],
  },
  {
    concept: 'UppskjutenSkattefordran',
    from: 'AndraLangfristigaFordringar',
    orientation: 'debit',
    ranges: [{ start: '1370', end: '1379' }],
  },
  {
    concept: 'FondUtvecklingsutgifter',
    from: 'Reservfond',
    orientation: 'credit',
    ranges: [{ start: '2089', end: '2089' }],
  },
  {
    concept: 'FondVerkligtVarde',
    from: 'BalanseratResultat',
    orientation: 'credit',
    ranges: [{ start: '2096', end: '2096' }],
  },
  {
    concept: 'UppskjutenSkatteskuld',
    from: 'OvrigaAvsattningar',
    orientation: 'credit',
    ranges: [{ start: '2240', end: '2249' }],
  },
  {
    concept: 'AvsattningarOvrigSkatt',
    from: 'OvrigaAvsattningar',
    orientation: 'credit',
    ranges: [{ start: '2250', end: '2259' }],
  },
]

/** Aktuell skattefordran: BAS 1640-1649 with a debit balance. */
const CURRENT_TAX_RECEIVABLE_RANGES: readonly Range[] = [{ start: '1640', end: '1649' }]
export const CURRENT_TAX_RECEIVABLE_CONCEPT = 'AktuellSkattefodran'

function inRanges(account: string, ranges: readonly Range[]): boolean {
  return ranges.some((range) => account >= range.start && account <= range.end)
}

/**
 * The K3 balance sheet post of a BAS account: the post K3 carves out for it
 * (K3_SPLITS), else the K2 post that holds it. Null when no post covers it.
 */
export function k3BrPostForAccount(account: string, legalForm: K2LegalForm): string | null {
  return K3_SPLITS.find((split) => inRanges(account, split.ranges))?.concept ?? k2BrPostForAccount(account, legalForm)
}

function net(row: TrialBalanceRowLike): number {
  return roundOre((row.closing_debit || 0) - (row.closing_credit || 0))
}

/** Whole kronor, as the mapper presents every post; -0 read as 0. */
function whole(amount: number): number {
  const rounded = Math.round(roundOre(amount))
  return rounded === 0 ? 0 : rounded
}

function splitAmount(rows: readonly TrialBalanceRowLike[], split: K3Split): number {
  const debitNet = sumOre(rows.filter((row) => inRanges(row.account_number, split.ranges)).map(net))
  return whole(split.orientation === 'debit' ? debitNet : -debitNet)
}

/**
 * The current tax receivable: 1640-1649 accounts in debit, plus the 25xx
 * skatteskulder when they net to a debit (the mapper moves that net to Övriga
 * fordringar: lib/reports/sign-reclassification.ts, tax_liability_debit_to_receivable).
 */
function currentTaxReceivable(rows: readonly TrialBalanceRowLike[]): number {
  const receivables = sumOre(
    rows.filter((row) => inRanges(row.account_number, CURRENT_TAX_RECEIVABLE_RANGES)).map(net).filter((n) => n > 0),
  )
  const rule = SIGN_RECLASSIFICATION_RULES.find((r) => r.id === 'tax_liability_debit_to_receivable')
  let overpaid = 0
  if (rule) {
    const balances = new Map(rows.map((row) => [row.account_number, net(row)]))
    const moved = new Set(selectReclassifiedAccounts(rule, balances))
    overpaid = sumOre(rows.filter((row) => moved.has(row.account_number)).map(net))
  }
  return whole(receivables + overpaid)
}

function move(br: ConceptAmounts, from: string, to: string, field: 'current' | 'previous', amount: number) {
  if (amount === 0) return
  const source: ConceptAmount = br[from] ?? { current: 0, previous: null }
  const target: ConceptAmount = br[to] ?? { current: 0, previous: null }
  br[from] = { ...source, [field]: (source[field] ?? 0) - amount }
  br[to] = { ...target, [field]: (target[field] ?? 0) + amount }
}

/**
 * The K2 mapping with K3's own posts. `current` and `previous` are the FULL
 * trial balances the BR was mapped from (previous null without a comparison
 * year). Totals are unchanged by construction; a split that cannot come out
 * of its K2 post (the post holds less than the split, which only a sign
 * reclassification could cause) is left in place.
 */
export function toK3Presentation(
  mapping: K2MappingResult,
  current: readonly TrialBalanceRowLike[],
  previous: readonly TrialBalanceRowLike[] | null,
): K3MappingResult {
  const br: ConceptAmounts = Object.fromEntries(
    Object.entries(mapping.br).map(([concept, amount]) => [concept, { ...amount }]),
  )
  const years: Array<['current' | 'previous', readonly TrialBalanceRowLike[]]> = [['current', current]]
  if (previous && mapping.totals.tillgangar.previous !== null) years.push(['previous', previous])
  for (const split of K3_SPLITS) {
    br[split.concept] = { current: 0, previous: mapping.totals.tillgangar.previous === null ? null : 0 }
  }
  br[CURRENT_TAX_RECEIVABLE_CONCEPT] = { current: 0, previous: mapping.totals.tillgangar.previous === null ? null : 0 }
  for (const [field, rows] of years) {
    for (const split of K3_SPLITS) {
      const amount = splitAmount(rows, split)
      const available = br[split.from]?.[field] ?? 0
      // Only what the K2 post actually holds moves (same sign, not more).
      if (amount === 0 || Math.sign(amount) !== Math.sign(available) || Math.abs(amount) > Math.abs(available)) continue
      move(br, split.from, split.concept, field, amount)
    }
    const tax = currentTaxReceivable(rows)
    const available = br['OvrigaFordringarKortfristiga']?.[field] ?? 0
    if (tax > 0 && available >= tax) move(br, 'OvrigaFordringarKortfristiga', CURRENT_TAX_RECEIVABLE_CONCEPT, field, tax)
  }
  // The K2 nudge to review 2089 under Reservfond does not apply: K3 shows it as its own post.
  const warnings = mapping.warnings.filter((warning) => !warning.startsWith('Fond för utvecklingsutgifter (2089)'))
  return { ...mapping, br, warnings, presentation: 'k3' }
}

/**
 * The equity posts of the K3 balance sheet: the K2 posts with fond för
 * utvecklingsutgifter (2089, bound) and fond för verkligt värde (2096, free)
 * as posts of their own, in ÅRL bilaga 1 order. The equity specification
 * (equity-specification.ts) runs on this list for a K3 report, so its
 * closing per post ties to toK3Presentation's balance sheet.
 */
export function k3EquityPosts(legalForm: K2LegalForm): EquityPostDefinition[] {
  const posts: EquityPostDefinition[] = []
  const withoutRange = (post: EquityPostDefinition, account: string): EquityPostDefinition => ({
    ...post,
    ranges: post.ranges.flatMap((range) => {
      if (account < range.start || account > range.end) return [range]
      const out: Range[] = []
      if (range.start < account) out.push({ start: range.start, end: String(Number(account) - 1) })
      if (account < range.end) out.push({ start: String(Number(account) + 1), end: range.end })
      return out
    }),
  })
  for (const post of k2EquityPosts(legalForm)) {
    if (post.concept === 'Reservfond') {
      posts.push(withoutRange(post, '2089'))
      posts.push({ concept: 'FondUtvecklingsutgifter', label: 'Fond för utvecklingsutgifter', bound: true, ranges: [{ start: '2089', end: '2089' }] })
      continue
    }
    if (post.concept === 'BalanseratResultat') {
      posts.push({ concept: 'FondVerkligtVarde', label: 'Fond för verkligt värde', bound: false, ranges: [{ start: '2096', end: '2096' }] })
      posts.push(withoutRange(post, '2096'))
      continue
    }
    posts.push(post)
  }
  return posts
}
