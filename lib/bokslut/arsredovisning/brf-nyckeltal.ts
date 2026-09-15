/**
 * Nyckeltal of a bostadsrättsförening (ÅRL 6 kap. 3 a § första stycket and
 * BFNAR 2012:1 punkt 38.3-38.9, chapter 38 as decided by BFN 2025-06-16).
 *
 * Pure: the caller supplies one year's trial-balance rows and the current
 * property facts, this module applies the definitions. Every ratio is null
 * when its denominator is missing or zero, never 0, so the PDF prints "-"
 * and completeness can tell "not computable" from "computed as zero".
 *
 * Account ranges, defined against the BRF seed in migration
 * 20260915170000 and BAS 2026:
 *   årsavgifter bostäder      3020, 3022-3029  (3022-3029: avgifter efter
 *                             individuell mätning, which 38.5 counts as
 *                             årsavgift; tillval such as bredband are not
 *                             årsavgift and belong on 3030-3039)
 *   årsavgifter lokaler       3021             (lokaler upplåtna med bostadsrätt)
 *   hyror bostäder            3011, 3015-3019
 *   hyror lokaler             3012
 *   hyror garage/parkering    3013-3014
 *   övriga avgifter           3030-3039        (överlåtelse-, pantsättnings-,
 *                             andrahandsavgifter, BRL 7 kap. 14 §, and tillval)
 *   nettoomsättning           3000-3799        (the K2/K3 mapping's
 *                             Nettoomsattning; årsavgifter and hyror are
 *                             primary income, K3 38 kommentar)
 *   totala rörelseintäkter    3000-3999
 *   räntebärande skulder      2330-2359, 2410-2419, 2480-2489
 *                             ("räntebärande skulder till kreditinstitut",
 *                             K3 38 kommentar: the K2 mapping's
 *                             Checkrakningskredit and
 *                             OvrigaSkulderKreditinstitut posts, long and
 *                             short; obligationslån 2300-2329 are not
 *                             skulder till kreditinstitut and are excluded)
 *   avskrivningar/nedskrivningar 7700-7899     (38.7: both are added back)
 *   utrangeringar             7970-7979        (förlust vid avyttring/
 *                             utrangering av anläggningstillgångar)
 *   planerat underhåll        5170-5179 unless the board's figure replaces it
 *   energikostnad             5300-5399        (BAS 53 energikostnader:
 *                             uppvärmning, el, vatten and their carriers;
 *                             38.9 names uppvärmning, el och vatten)
 *
 * Area definitions (38 kommentar to 6 kap. 3 a §): "per kvadratmeter" means
 * every area the association charges an avgift or hyra for, i.e. kvm
 * upplåten med bostadsrätt plus kvm upplåten med hyresrätt (bostäder and
 * lokaler); common areas without a charge are excluded. "Per kvadratmeter
 * upplåten med bostadsrätt" is kvm_bostadsratt alone, which per 38.5
 * already includes lokaler upplåtna med bostadsrätt.
 */
import type { TrialBalanceRow } from '@/types'

export interface BrfPropertyFactsForNyckeltal {
  kvm_bostadsratt: number | null
  kvm_hyresratt: number | null
  kvm_lokaler: number | null
  /** Share of kvm_bostadsratt that is lokaler (K3 38.3 c). */
  kvm_lokaler_bostadsratt: number | null
}

export interface BrfNyckeltalOverrides {
  /** K3 38.7: kostnadsfört planerat underhåll, replaces the 5170-5179 default. */
  planerat_underhall_override?: number | null
  /** K3 38.7 third paragraph: signed adjustment to justerat resultat. */
  sparande_adjustment?: number | null
}

export interface BrfNyckeltalRow {
  /** Fiscal-period name (e.g. "2026"). */
  year: string
  /** K3 38.3 a, kr (3000-3799). */
  nettoomsattning: number
  /** ÅRL 6 kap. 1 §: resultat efter finansiella poster, kr. */
  resultat_efter_finansiella_poster: number
  /** K3 38.3 b: eget kapital (incl. equity share of obeskattade reserver) / balansomslutning, %. */
  soliditet_pct: number | null
  /** ÅRL 6 kap. 3 a § 1: årsavgifter / kvm upplåten med bostadsrätt, kr/kvm. */
  arsavgift_per_kvm_bostadsratt: number | null
  /** K3 38.3 c: årsavgifter bostäder / (kvm_bostadsratt - kvm_lokaler_bostadsratt). */
  arsavgift_per_kvm_bostader: number | null
  /** K3 38.3 c: årsavgifter lokaler / kvm_lokaler_bostadsratt; null with no lokaler upplåtna med bostadsrätt. */
  arsavgift_per_kvm_lokaler: number | null
  /** ÅRL 6 kap. 3 a § 2, K3 38.6: räntebärande skulder / (kvm bostadsrätt + hyresrätt). */
  skuldsattning_per_kvm: number | null
  /** K3 38.3 d: räntebärande skulder / kvm upplåten med bostadsrätt. */
  skuldsattning_per_kvm_bostadsratt: number | null
  /** ÅRL 6 kap. 3 a § 3, K3 38.7: justerat resultat / (kvm bostadsrätt + hyresrätt). */
  sparande_per_kvm: number | null
  /** ÅRL 6 kap. 3 a § 4, K3 38.8: 1 % of räntebärande skulder / årsavgifter, %. */
  rantekanslighet_pct: number | null
  /** ÅRL 6 kap. 3 a § 5, K3 38.9: energikostnad / (kvm bostadsrätt + hyresrätt). */
  energikostnad_per_kvm: number | null
  /** K3 38.3 e: årsavgifter / totala rörelseintäkter, %. */
  arsavgifternas_andel_pct: number | null
  /** The figures behind the ratios, kr, for the definitions block and tests. */
  underlag: {
    arsavgifter: number
    arsavgifter_bostader: number
    arsavgifter_lokaler: number
    rantebarande_skulder: number
    arets_resultat: number
    avskrivningar: number
    utrangeringar: number
    planerat_underhall: number
    sparande_adjustment: number
    justerat_resultat: number
    energikostnad: number
    totala_intakter: number
    kvm_bostadsratt: number | null
    kvm_upplaten_total: number | null
  }
}

/** K3 38.13: what the post Nettoomsättning consists of, kr. */
export interface BrfNettoomsattningSplit {
  arsavgifter_bostader: number
  arsavgifter_lokaler: number
  hyror_bostader: number
  hyror_lokaler: number
  hyror_garage_parkering: number
  ovriga_avgifter: number
  /** Everything else inside 3000-3799. */
  ovrigt: number
  total: number
}

type Range = readonly [string, string]

export const BRF_NYCKELTAL_ACCOUNTS = {
  arsavgifterBostader: [['3020', '3020'], ['3022', '3029']] as readonly Range[],
  arsavgifterLokaler: [['3021', '3021']] as readonly Range[],
  hyrorBostader: [['3011', '3011'], ['3015', '3019']] as readonly Range[],
  hyrorLokaler: [['3012', '3012']] as readonly Range[],
  hyrorGarageParkering: [['3013', '3014']] as readonly Range[],
  ovrigaAvgifter: [['3030', '3039']] as readonly Range[],
  nettoomsattning: [['3000', '3799']] as readonly Range[],
  totalaIntakter: [['3000', '3999']] as readonly Range[],
  rantebarandeSkulder: [['2330', '2359'], ['2410', '2419'], ['2480', '2489']] as readonly Range[],
  avskrivningar: [['7700', '7899']] as readonly Range[],
  utrangeringar: [['7970', '7979']] as readonly Range[],
  planeratUnderhall: [['5170', '5179']] as readonly Range[],
  energikostnad: [['5300', '5399']] as readonly Range[],
} as const

type Row = Pick<TrialBalanceRow, 'account_number' | 'closing_debit' | 'closing_credit'>

function inRanges(account: string, ranges: readonly Range[]): boolean {
  return ranges.some(([from, to]) => account >= from && account <= to)
}

/** Net credit balance (income, liabilities) of the accounts in the ranges. */
export function sumCredit(rows: readonly Row[], ranges: readonly Range[]): number {
  let sum = 0
  for (const row of rows) {
    if (inRanges(row.account_number, ranges)) sum += row.closing_credit - row.closing_debit
  }
  return Math.round(sum * 100) / 100
}

/** Net debit balance (costs) of the accounts in the ranges. */
export function sumDebit(rows: readonly Row[], ranges: readonly Range[]): number {
  const value = -sumCredit(rows, ranges)
  return value === 0 ? 0 : value
}

function ratio(numerator: number, denominator: number | null | undefined, decimals = 0): number | null {
  if (denominator === null || denominator === undefined || !(denominator > 0)) return null
  const factor = 10 ** decimals
  return Math.round((numerator / denominator) * factor) / factor
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export interface ComputeBrfNyckeltalInput {
  year: string
  /** Trial balance with the resultatavslut excluded (class 3-8 open). */
  preClosingRows: readonly Row[]
  /** Trial balance with the resultatavslut included (BR balances). */
  fullRows: readonly Row[]
  /** ÅRL 6 kap. 1 §; taken from the statement mapping so the FB table ties. */
  resultat_efter_finansiella_poster: number
  soliditet_pct: number | null
  /** Årets resultat from the statement mapping (RR). */
  arets_resultat: number
  facts: BrfPropertyFactsForNyckeltal | null
  overrides?: BrfNyckeltalOverrides
}

export function computeBrfNyckeltal(input: ComputeBrfNyckeltalInput): BrfNyckeltalRow {
  const rr = input.preClosingRows
  const br = input.fullRows
  const A = BRF_NYCKELTAL_ACCOUNTS
  const arsavgifterBostader = sumCredit(rr, A.arsavgifterBostader)
  const arsavgifterLokaler = sumCredit(rr, A.arsavgifterLokaler)
  const arsavgifter = Math.round((arsavgifterBostader + arsavgifterLokaler) * 100) / 100
  const nettoomsattning = sumCredit(rr, A.nettoomsattning)
  const totalaIntakter = sumCredit(rr, A.totalaIntakter)
  const rantebarandeSkulder = sumCredit(br, A.rantebarandeSkulder)
  const avskrivningar = sumDebit(rr, A.avskrivningar)
  const utrangeringar = sumDebit(rr, A.utrangeringar)
  const planeratUnderhallLedger = sumDebit(rr, A.planeratUnderhall)
  const override = input.overrides?.planerat_underhall_override
  const planeratUnderhall =
    typeof override === 'number' && Number.isFinite(override) ? override : planeratUnderhallLedger
  const adjustment = input.overrides?.sparande_adjustment
  const sparandeAdjustment =
    typeof adjustment === 'number' && Number.isFinite(adjustment) ? adjustment : 0
  // K3 38.7: årets resultat + avskrivningar + utrangeringar + kostnadsfört
  // planerat underhåll, then the material non-recurring items.
  const justeratResultat =
    Math.round(
      (input.arets_resultat + avskrivningar + utrangeringar + planeratUnderhall + sparandeAdjustment) * 100,
    ) / 100
  const energikostnad = sumDebit(rr, A.energikostnad)

  const kvmBostadsratt = positiveOrNull(input.facts?.kvm_bostadsratt)
  const kvmHyresratt = input.facts?.kvm_hyresratt ?? 0
  const kvmLokaler = input.facts?.kvm_lokaler ?? 0
  const kvmUpplatenTotal =
    kvmBostadsratt === null
      ? null
      : positiveOrNull(kvmBostadsratt + Math.max(0, kvmHyresratt) + Math.max(0, kvmLokaler))
  const kvmLokalerBostadsratt = positiveOrNull(input.facts?.kvm_lokaler_bostadsratt)
  const kvmBostaderBostadsratt =
    kvmBostadsratt === null ? null : positiveOrNull(kvmBostadsratt - (kvmLokalerBostadsratt ?? 0))

  return {
    year: input.year,
    nettoomsattning: Math.round(nettoomsattning),
    resultat_efter_finansiella_poster: Math.round(input.resultat_efter_finansiella_poster),
    soliditet_pct: input.soliditet_pct,
    arsavgift_per_kvm_bostadsratt: ratio(arsavgifter, kvmBostadsratt),
    arsavgift_per_kvm_bostader: ratio(arsavgifterBostader, kvmBostaderBostadsratt),
    arsavgift_per_kvm_lokaler:
      kvmLokalerBostadsratt === null ? null : ratio(arsavgifterLokaler, kvmLokalerBostadsratt),
    skuldsattning_per_kvm: ratio(rantebarandeSkulder, kvmUpplatenTotal),
    skuldsattning_per_kvm_bostadsratt: ratio(rantebarandeSkulder, kvmBostadsratt),
    sparande_per_kvm: ratio(justeratResultat, kvmUpplatenTotal),
    // 38.8: one percent of the interest-bearing debt over the year's årsavgifter.
    rantekanslighet_pct: ratio(rantebarandeSkulder * 0.01 * 100, arsavgifter, 1),
    energikostnad_per_kvm: ratio(energikostnad, kvmUpplatenTotal),
    arsavgifternas_andel_pct: ratio(arsavgifter * 100, totalaIntakter, 1),
    underlag: {
      arsavgifter,
      arsavgifter_bostader: arsavgifterBostader,
      arsavgifter_lokaler: arsavgifterLokaler,
      rantebarande_skulder: rantebarandeSkulder,
      arets_resultat: input.arets_resultat,
      avskrivningar,
      utrangeringar,
      planerat_underhall: planeratUnderhall,
      sparande_adjustment: sparandeAdjustment,
      justerat_resultat: justeratResultat,
      energikostnad,
      totala_intakter: totalaIntakter,
      kvm_bostadsratt: kvmBostadsratt,
      kvm_upplaten_total: kvmUpplatenTotal,
    },
  }
}

/** K3 38.13: the note splitting Nettoomsättning by kind of income. */
export function computeBrfNettoomsattningSplit(preClosingRows: readonly Row[]): BrfNettoomsattningSplit {
  const A = BRF_NYCKELTAL_ACCOUNTS
  const arsavgifterBostader = sumCredit(preClosingRows, A.arsavgifterBostader)
  const arsavgifterLokaler = sumCredit(preClosingRows, A.arsavgifterLokaler)
  const hyrorBostader = sumCredit(preClosingRows, A.hyrorBostader)
  const hyrorLokaler = sumCredit(preClosingRows, A.hyrorLokaler)
  const hyrorGarageParkering = sumCredit(preClosingRows, A.hyrorGarageParkering)
  const ovrigaAvgifter = sumCredit(preClosingRows, A.ovrigaAvgifter)
  const total = sumCredit(preClosingRows, A.nettoomsattning)
  const named =
    arsavgifterBostader + arsavgifterLokaler + hyrorBostader + hyrorLokaler + hyrorGarageParkering + ovrigaAvgifter
  return {
    arsavgifter_bostader: Math.round(arsavgifterBostader),
    arsavgifter_lokaler: Math.round(arsavgifterLokaler),
    hyror_bostader: Math.round(hyrorBostader),
    hyror_lokaler: Math.round(hyrorLokaler),
    hyror_garage_parkering: Math.round(hyrorGarageParkering),
    ovriga_avgifter: Math.round(ovrigaAvgifter),
    ovrigt: Math.round(total - named),
    total: Math.round(total),
  }
}

/** Which property facts the ratios need and do not have (completeness AR-BRF-FACTS-MISSING). */
export function missingBrfFacts(facts: BrfPropertyFactsForNyckeltal | null): string[] {
  const missing: string[] = []
  if (!facts) return ['kvm_bostadsratt', 'kvm_hyresratt', 'kvm_lokaler']
  if (positiveOrNull(facts.kvm_bostadsratt) === null) missing.push('kvm_bostadsratt')
  if (facts.kvm_hyresratt === null || facts.kvm_hyresratt === undefined) missing.push('kvm_hyresratt')
  if (facts.kvm_lokaler === null || facts.kvm_lokaler === undefined) missing.push('kvm_lokaler')
  return missing
}

/** The building carried on the asset accounts of the BRF seed (K3 17.4 with 38.10). */
export const BRF_BUILDING_ACCOUNTS: readonly Range[] = [['1110', '1118']]

/** Net debit balance of the building accounts (accumulated depreciation on 1119 excluded). */
export function buildingCarryingAmount(fullRows: readonly Row[]): number {
  return sumDebit(fullRows, BRF_BUILDING_ACCOUNTS)
}
