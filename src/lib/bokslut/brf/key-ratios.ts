import type { TrialBalanceRow } from '@/types'
import { roundOre } from '@/lib/money'

/**
 * The key ratios a bostadsrättsförening gives in its förvaltningsberättelse:
 * ÅRL 6 kap. 3 a § första stycket 1-5 and K3 38.3 a-b, for the year and the
 * three previous years (38.5), computed as K3 38.6-38.11 define them.
 *
 *   årsavgift per kvm upplåten med bostadsrätt     årsavgifter / kvm BR       (38.6)
 *   skuldsättning per kvm                         räntebärande skulder / kvm (38.7)
 *   skuldsättning per kvm upplåten med bostadsrätt räntebärande / kvm BR      (38.7, 38.3 a)
 *   sparande per kvm                              justerat resultat / kvm    (38.8)
 *   räntekänslighet (read as %)                   räntebärande / årsavgifter (38.9)
 *   energikostnad per kvm                         värme + el + vatten / kvm  (38.10)
 *   årsavgifternas andel av rörelseintäkterna, %  årsavgifter / rörelseint.  (38.11, 38.3 b)
 *
 * "kvm" is every area the förening charges a fee or rent for, bostadsrätt and
 * hyresrätt together; "kvm BR" only the area upplåten med bostadsrätt (the
 * comments to 38.6 and 38.7). Justerat resultat is årets resultat plus
 * avskrivningar, utrangeringar and kostnadsfört planerat underhåll, plus
 * väsentliga kostnader and less väsentliga intäkter outside the normal
 * activity (38.8).
 *
 * The amounts are facts the förening states: what counts as årsavgift (38.6),
 * which costs are värme, el and vatten, what was planned underhåll. BAS has
 * no accounts for them, so `ledgerFactsForKeyRatios` reads them through an
 * account mapping the förening sets once and the builder takes the amounts.
 * A standalone builder: wiring into the K3 förvaltningsberättelse is P1's
 * disclosure matrix (requirement ids in chapter-38-disclosures.ts).
 */

export interface BrfKeyRatioYearInput {
  /** The financial year's last day, the column's label. */
  period_end: string
  /** Årsavgifter as K3 38.6 defines them (consumption-based fees included, optional services not). */
  arsavgifter: number
  /** Summa rörelseintäkter, lagerförändringar m.m. (38.11). */
  rorelseintakter: number
  /** Räntebärande skulder på balansdagen (38.7, 38.9). */
  rantebarande_skulder: number
  /** Kostnader för värme, el och vatten, re-invoiced costs included (38.10). */
  energikostnader: { varme: number; el: number; vatten: number }
  arets_resultat: number
  avskrivningar: number
  utrangeringar: number
  /** Kostnadsfört planerat underhåll (38.8 kommentar). */
  planerat_underhall: number
  /** Väsentliga intäkter and kostnader outside the normal activity (38.8 andra stycket). */
  ej_normal_verksamhet: { intakter: number; kostnader: number }
  /** Kvadratmeter upplåtna med bostadsrätt (boarea and lokalarea). */
  kvm_bostadsratt: number
  /** Kvadratmeter upplåtna med hyresrätt. */
  kvm_hyresratt: number
}

export interface BrfKeyRatios {
  period_end: string
  arsavgift_per_kvm_bostadsratt: number | null
  skuldsattning_per_kvm: number | null
  skuldsattning_per_kvm_bostadsratt: number | null
  sparande_per_kvm: number | null
  justerat_resultat: number
  /**
   * Räntebärande skulder / årsavgifter, read as percent: how many percent the
   * årsavgifter rise if the interest rate rises one percentage point (38.9
   * kommentar: 100 000 000 / 7 750 000 = 12,90 procent).
   */
  rantekanslighet: number | null
  energikostnad_per_kvm: number | null
  /** Percent. */
  arsavgifternas_andel_av_rorelseintakter: number | null
}

export type BrfKeyRatioIssueCode =
  | 'BRF_KEY_RATIOS_FEWER_THAN_FOUR_YEARS'
  | 'BRF_KEY_RATIOS_NO_AREA'
  | 'BRF_KEY_RATIOS_NO_ARSAVGIFTER'
  | 'BRF_KEY_RATIOS_NO_RORELSEINTAKTER'

export interface BrfKeyRatioIssue {
  code: BrfKeyRatioIssueCode
  period_end: string | null
  /** The rule the issue is about. */
  source: string
}

export interface BrfKeyRatioTable {
  /** Newest year first, at most four (38.5). */
  years: BrfKeyRatios[]
  issues: BrfKeyRatioIssue[]
}

const ore = (value: number) => roundOre(value) || 0

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? ore(numerator / denominator) : null
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? ore((numerator / denominator) * 100) : null
}

export function computeBrfKeyRatios(year: BrfKeyRatioYearInput): BrfKeyRatios {
  const kvm = year.kvm_bostadsratt + year.kvm_hyresratt
  const justeratResultat = ore(
    year.arets_resultat + year.avskrivningar + year.utrangeringar + year.planerat_underhall
      + year.ej_normal_verksamhet.kostnader - year.ej_normal_verksamhet.intakter,
  )
  const energi = year.energikostnader.varme + year.energikostnader.el + year.energikostnader.vatten
  return {
    period_end: year.period_end,
    arsavgift_per_kvm_bostadsratt: ratio(year.arsavgifter, year.kvm_bostadsratt),
    skuldsattning_per_kvm: ratio(year.rantebarande_skulder, kvm),
    skuldsattning_per_kvm_bostadsratt: ratio(year.rantebarande_skulder, year.kvm_bostadsratt),
    sparande_per_kvm: ratio(justeratResultat, kvm),
    justerat_resultat: justeratResultat,
    rantekanslighet: ratio(year.rantebarande_skulder, year.arsavgifter),
    energikostnad_per_kvm: ratio(energi, kvm),
    arsavgifternas_andel_av_rorelseintakter: percent(year.arsavgifter, year.rorelseintakter),
  }
}

/**
 * The four-year table (38.5), newest first. A förening younger than four
 * years gives the years it has; the issue says so, so the reader can tell a
 * short history from a missing input.
 */
export function buildBrfKeyRatioTable(years: readonly BrfKeyRatioYearInput[]): BrfKeyRatioTable {
  const sorted = [...years].sort((a, b) => b.period_end.localeCompare(a.period_end)).slice(0, 4)
  const issues: BrfKeyRatioIssue[] = []
  if (sorted.length < 4) {
    issues.push({ code: 'BRF_KEY_RATIOS_FEWER_THAN_FOUR_YEARS', period_end: null, source: 'K3 38.5' })
  }
  for (const year of sorted) {
    if (year.kvm_bostadsratt <= 0) {
      issues.push({ code: 'BRF_KEY_RATIOS_NO_AREA', period_end: year.period_end, source: 'ÅRL 6 kap. 3 a §' })
    }
    if (year.arsavgifter <= 0) {
      issues.push({ code: 'BRF_KEY_RATIOS_NO_ARSAVGIFTER', period_end: year.period_end, source: 'K3 38.6' })
    }
    if (year.rorelseintakter <= 0) {
      issues.push({ code: 'BRF_KEY_RATIOS_NO_RORELSEINTAKTER', period_end: year.period_end, source: 'K3 38.11' })
    }
  }
  return { years: sorted.map(computeBrfKeyRatios), issues }
}

// ─── From the ledger ────────────────────────────────────────────────────

/**
 * Which accounts hold the amounts the key ratios need. Set once by the
 * förening (its chart decides: BAS has no årsavgift or energy accounts).
 * Prefixes, like '3010' or '461'.
 */
export interface BrfKeyRatioAccountMapping {
  arsavgifter: string[]
  energi: { varme: string[]; el: string[]; vatten: string[] }
  planerat_underhall: string[]
  utrangeringar: string[]
  /** Defaults to RANTEBARANDE_SKULDER_DEFAULT. */
  rantebarande_skulder?: string[]
}

/**
 * Interest-bearing debt in BAS: long-term borrowing (231x-237x), kontokredit
 * (233x, 248x), short-term loans from credit institutions (241x) and other
 * short-term loans (284x). Leverantörskrediter (2394) and depositions (2397)
 * are not loans and are left out.
 */
export const RANTEBARANDE_SKULDER_DEFAULT: readonly string[] = [
  '231', '232', '233', '234', '235', '236', '237', '2391', '2393', '2395', '241', '248', '284',
]

const startsWithAny = (account: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => account.startsWith(prefix))

/** Period movement (income positive) and closing balance (liability positive) by mapping. */
export function ledgerFactsForKeyRatios(
  rows: readonly TrialBalanceRow[],
  mapping: BrfKeyRatioAccountMapping,
): Pick<
  BrfKeyRatioYearInput,
  'arsavgifter' | 'rorelseintakter' | 'rantebarande_skulder' | 'energikostnader' | 'arets_resultat'
  | 'avskrivningar' | 'utrangeringar' | 'planerat_underhall'
> {
  const income = (prefixes: readonly string[]) => ore(rows
    .filter((row) => startsWithAny(row.account_number, prefixes))
    .reduce((sum, row) => sum + (row.period_credit || 0) - (row.period_debit || 0), 0))
  const cost = (prefixes: readonly string[]) => -income(prefixes) || 0
  const closingCredit = (prefixes: readonly string[]) => ore(rows
    .filter((row) => startsWithAny(row.account_number, prefixes))
    .reduce((sum, row) => sum + (row.closing_credit || 0) - (row.closing_debit || 0), 0))
  const resultAccounts = rows.filter((row) => /^[3-8]/.test(row.account_number) && !row.account_number.startsWith('899'))
  return {
    arsavgifter: income(mapping.arsavgifter),
    // Rörelseintäkter: BAS classes 3 (nettoomsättning, övriga rörelseintäkter).
    rorelseintakter: income(['3']),
    rantebarande_skulder: closingCredit(mapping.rantebarande_skulder ?? RANTEBARANDE_SKULDER_DEFAULT),
    energikostnader: {
      varme: cost(mapping.energi.varme),
      el: cost(mapping.energi.el),
      vatten: cost(mapping.energi.vatten),
    },
    arets_resultat: ore(resultAccounts.reduce((sum, row) => sum + (row.period_credit || 0) - (row.period_debit || 0), 0)),
    // Avskrivningar on anläggningstillgångar (78xx).
    avskrivningar: cost(['78']),
    utrangeringar: cost(mapping.utrangeringar),
    planerat_underhall: cost(mapping.planerat_underhall),
  }
}
