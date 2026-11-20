import { roundOre } from '@/lib/money'
import type { BrfKeyRatioTable } from './key-ratios'

/**
 * The förvaltningsberättelse and note facts a bostadsrättsförening states
 * under K3 kapitel 38 (BFNAR 2025:3) and ÅRL 6 kap. 3 a §, as typed inputs
 * with one validator. Nothing here is read from the ledger: each is a fact
 * the styrelse confirms. The key ratios themselves are key-ratios.ts.
 *
 * `BRF_DISCLOSURE_REQUIREMENTS` lists each requirement with its source and
 * producer in the shape the K3 disclosure matrix (P1) takes, applicable when
 * the form's profile has `filings.housingKeyRatios`.
 */

export interface BrfChapter38Input {
  /** 38.2 a: privatbostadsföretag enligt IL 2 kap. 17 § (äkta förening) or not. */
  privatbostadsforetag: boolean | null
  /** 38.2 b: the land is held med äganderätt or med tomträtt. */
  markinnehav: 'aganderatt' | 'tomtratt' | null
  /** 38.2 andra stycket, when tomträtt: earliest uppsägning and when the avgäldsperiod ends. */
  tomtratt: { tidigast_uppsagning: string | null; avgaldsperiod_slut: string | null } | null
  /** 38.2 c and tredje stycket: part in a samfällighet, and what it manages. */
  samfallighet: { har_del: boolean; forvaltar: string | null } | null
  /** 38.2 d: an aktuell underhållsplan, and whether it is the BRL teknisk underhållsplan. */
  underhallsplan: { aktuell: boolean; teknisk_enligt_brl: boolean } | null
  /** 38.4: a key ratio that is not representative for the individual bostadsrätter, and why. */
  nyckeltal_ej_representativa: string | null
  /** 38.10 andra stycket: costs for värme, el or vatten not included in the årsavgift. */
  energi_ej_i_arsavgift: { varme: boolean; el: boolean; vatten: boolean }
  /** ÅRL 6 kap. 3 a § andra stycket, 38.12: how future commitments are financed after a loss. */
  forlust_finansiering: string | null
  /** 38.17: the kinds of income in nettoomsättning with their amounts. */
  nettoomsattning: Array<{ slag: string; belopp: number }>
  /** 38.17 andra meningen: what the årsavgift includes (värme, el, vatten, tv, bredband, parkering ...). */
  arsavgift_innehall: string | null
}

export type BrfDisclosureRequirementId =
  | 'brf.privatbostadsforetag'
  | 'brf.markinnehav'
  | 'brf.tomtratt'
  | 'brf.samfallighet'
  | 'brf.underhallsplan'
  | 'brf.nyckeltal'
  | 'brf.nyckeltal_representativa'
  | 'brf.energi_ej_i_arsavgift'
  | 'brf.forlust_finansiering'
  | 'brf.nettoomsattning'
  | 'brf.arsavgift_innehall'
  | 'brf.fond_yttre_underhall'
  | 'brf.kassaflodesanalys'

export interface BrfDisclosureRequirement {
  id: BrfDisclosureRequirementId
  /** Primary source. */
  source: string
  /** Where it is printed. */
  placement: 'forvaltningsberattelse' | 'not' | 'balansrakning' | 'kassaflodesanalys'
  /** typed: the förening states it; generated: computed from the ledger and stated facts. */
  producer: 'typed' | 'generated'
}

export const BRF_DISCLOSURE_REQUIREMENTS: readonly BrfDisclosureRequirement[] = [
  { id: 'brf.privatbostadsforetag', source: 'K3 38.2 a', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.markinnehav', source: 'K3 38.2 b', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.tomtratt', source: 'K3 38.2 andra stycket', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.samfallighet', source: 'K3 38.2 c, tredje stycket', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.underhallsplan', source: 'K3 38.2 d', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.nyckeltal', source: 'ÅRL 6 kap. 3 a § första stycket; K3 38.3, 38.5-38.11', placement: 'forvaltningsberattelse', producer: 'generated' },
  { id: 'brf.nyckeltal_representativa', source: 'K3 38.4', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.energi_ej_i_arsavgift', source: 'K3 38.10 andra stycket', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.forlust_finansiering', source: 'ÅRL 6 kap. 3 a § andra stycket; K3 38.12', placement: 'forvaltningsberattelse', producer: 'typed' },
  { id: 'brf.nettoomsattning', source: 'K3 38.17 första stycket', placement: 'not', producer: 'typed' },
  { id: 'brf.arsavgift_innehall', source: 'K3 38.17 andra stycket', placement: 'not', producer: 'typed' },
  { id: 'brf.fond_yttre_underhall', source: 'K3 38.14-38.15; 6.3', placement: 'balansrakning', producer: 'generated' },
  { id: 'brf.kassaflodesanalys', source: 'ÅRL 2 kap. 1 § andra stycket; K3 38.16', placement: 'kassaflodesanalys', producer: 'generated' },
]

export type BrfDisclosureIssueCode =
  | 'BRF_PRIVATBOSTADSFORETAG_MISSING'
  | 'BRF_MARKINNEHAV_MISSING'
  | 'BRF_TOMTRATT_DATES_MISSING'
  | 'BRF_SAMFALLIGHET_MISSING'
  | 'BRF_SAMFALLIGHET_FORVALTAR_MISSING'
  | 'BRF_UNDERHALLSPLAN_MISSING'
  | 'BRF_FORLUST_FINANSIERING_MISSING'
  | 'BRF_NETTOOMSATTNING_MISSING'
  | 'BRF_NETTOOMSATTNING_DOES_NOT_TIE'
  | 'BRF_ARSAVGIFT_INNEHALL_MISSING'

export interface BrfDisclosureIssue {
  code: BrfDisclosureIssueCode
  requirement: BrfDisclosureRequirementId
  /** Blocking issues stop a lock of the årsredovisning; a warning is shown. */
  severity: 'blocking' | 'warning'
}

export interface BrfChapter38Context {
  /** Årets resultat: a loss requires the financing statement (6 kap. 3 a § andra stycket). */
  arets_resultat: number
  /** Nettoomsättning in the resultaträkning, which the 38.17 specification must add up to. */
  nettoomsattning: number
}

const blocking = (code: BrfDisclosureIssueCode, requirement: BrfDisclosureRequirementId): BrfDisclosureIssue =>
  ({ code, requirement, severity: 'blocking' })

const filled = (text: string | null | undefined) => typeof text === 'string' && text.trim().length > 0

/** What is missing or inconsistent in the stated chapter 38 facts. */
export function validateBrfChapter38(input: BrfChapter38Input, context: BrfChapter38Context): BrfDisclosureIssue[] {
  const issues: BrfDisclosureIssue[] = []
  if (input.privatbostadsforetag === null) issues.push(blocking('BRF_PRIVATBOSTADSFORETAG_MISSING', 'brf.privatbostadsforetag'))
  if (input.markinnehav === null) issues.push(blocking('BRF_MARKINNEHAV_MISSING', 'brf.markinnehav'))
  if (input.markinnehav === 'tomtratt'
    && (!filled(input.tomtratt?.tidigast_uppsagning) || !filled(input.tomtratt?.avgaldsperiod_slut))) {
    issues.push(blocking('BRF_TOMTRATT_DATES_MISSING', 'brf.tomtratt'))
  }
  if (input.samfallighet === null) issues.push(blocking('BRF_SAMFALLIGHET_MISSING', 'brf.samfallighet'))
  else if (input.samfallighet.har_del && !filled(input.samfallighet.forvaltar)) {
    issues.push(blocking('BRF_SAMFALLIGHET_FORVALTAR_MISSING', 'brf.samfallighet'))
  }
  if (input.underhallsplan === null) issues.push(blocking('BRF_UNDERHALLSPLAN_MISSING', 'brf.underhallsplan'))
  if (context.arets_resultat < 0 && !filled(input.forlust_finansiering)) {
    issues.push(blocking('BRF_FORLUST_FINANSIERING_MISSING', 'brf.forlust_finansiering'))
  }
  if (input.nettoomsattning.length === 0) {
    issues.push(blocking('BRF_NETTOOMSATTNING_MISSING', 'brf.nettoomsattning'))
  } else {
    const specified = input.nettoomsattning.reduce((sum, row) => sum + row.belopp, 0)
    if ((roundOre(specified) || 0) !== (roundOre(context.nettoomsattning) || 0)) {
      issues.push(blocking('BRF_NETTOOMSATTNING_DOES_NOT_TIE', 'brf.nettoomsattning'))
    }
  }
  if (!filled(input.arsavgift_innehall)) issues.push(blocking('BRF_ARSAVGIFT_INNEHALL_MISSING', 'brf.arsavgift_innehall'))
  return issues
}

/**
 * The statements 38.10 andra stycket requires, one per cost the årsavgift
 * does not include, in the order värme, el, vatten.
 */
export function energyExclusionStatements(input: BrfChapter38Input): Array<'varme' | 'el' | 'vatten'> {
  return (['varme', 'el', 'vatten'] as const).filter((cost) => input.energi_ej_i_arsavgift[cost])
}

/** Everything the förvaltningsberättelse needs from chapter 38, validated. */
export interface BrfForvaltningsberattelseFacts {
  input: BrfChapter38Input
  keyRatios: BrfKeyRatioTable
  energyExclusions: Array<'varme' | 'el' | 'vatten'>
  issues: BrfDisclosureIssue[]
}

export function buildBrfForvaltningsberattelseFacts(
  input: BrfChapter38Input,
  keyRatios: BrfKeyRatioTable,
  context: BrfChapter38Context,
): BrfForvaltningsberattelseFacts {
  return {
    input,
    keyRatios,
    energyExclusions: energyExclusionStatements(input),
    issues: validateBrfChapter38(input, context),
  }
}
