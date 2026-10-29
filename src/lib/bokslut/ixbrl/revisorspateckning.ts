/**
 * The revisorspåteckning: the revisor's hänvisning to the revisionsberättelse
 * on the årsredovisning (ABL 9 kap. 28 § andra stycket; every revisor when
 * there are several, 28 a §).
 *
 * One builder for every renderer. Its inputs:
 *   - the revisor slots of the signer roster (roles AUDITOR_SIGNER_ROLES):
 *     name, title, and the påteckning date (the slot's signed_at), and
 *   - the profile's period facts: whether a revisionsberättelse is required,
 *     the registered revisionsbolag (when a firm is the revisor), and what the
 *     revisionsberättelse says (auditor_opinion).
 *
 * Its output is IxbrlRevisorspateckning, which the iXBRL document tags in the
 * signature section with the concepts the taxonomy's "Undertecknande av
 * företrädare och revisionspåteckning" delrapport defines (fsign):
 *   - RevisorspateckningRevisionsberattelseEnligtStandardutformning (date)
 *     for a revisionsberättelse without modifierade uttalanden,
 *   - RevisorspateckningRevisionsberattelseAvvikerStandardutformning (date)
 *     for one with them, plus the påteckningsmening vallista
 *     RevisorspateckningRevisionsberattelseAvstyrktResultatrakningenBalansrakningenList
 *     when the revisionsberättelse avstyrker, or neither tillstyrker nor
 *     avstyrker, that the statements are adopted,
 *   - ValtRevisionsbolagsnamn for the firm, and per revisor the tuple
 *     UnderskriftRevisorspateckningTuple (tilltalsnamn, efternamn, titel,
 *     huvudansvarig revisor).
 * The PDF prints the same sentence from the same builder.
 */

import { isAuditorRole, type AuditorOpinion } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import { signatureDate } from '@/lib/bokslut/arsredovisning/signature-pages'

export interface IxbrlRevisor {
  firstName: string
  lastName: string
  /** The roster role, tagged as UnderskriftHandlingTitel. */
  titel: string
  /** True for the revisionsbolag's huvudansvarig revisor; null without a firm. */
  huvudansvarig: boolean | null
  /** Påteckning date (YYYY-MM-DD); null while not recorded. */
  signedDate: string | null
}

export interface IxbrlRevisorspateckning {
  /** A revisionsberättelse is required for the period (profile answer). */
  required: boolean
  /** Registered revisionsbolag elected as revisor, or null. */
  revisionsbolag: string | null
  /** What the revisionsberättelse says; null while unanswered. */
  opinion: AuditorOpinion | null
  revisorer: IxbrlRevisor[]
}

interface OpinionDefinition {
  /** True for a revisionsberättelse with modifierade uttalanden. */
  modified: boolean
  /** se-mem-base member of the påteckningsmening vallista, or null. */
  member: string | null
  /** The påteckningsmening after "Jag har i denna" / "Vi har i denna". */
  sentence: string | null
}

/**
 * auditor_opinion → taxonomy. The member names and sentences are the K2 AB
 * 2024-09-12 element list's (sheet "Undertecknande av företrädare", rows
 * 1245-1252); the K3 2021-10-31 fsign form holds the same members.
 */
export const AUDITOR_OPINION_DEFINITIONS: Record<AuditorOpinion, OpinionDefinition> = {
  unmodified: { modified: false, member: null, sentence: null },
  modified: { modified: true, member: null, sentence: null },
  avstyrkt_rr_br: {
    modified: true,
    member: 'RevisorspateckningMeningAvstyrktAttResultatrakningBalansrakningFaststallsMember',
    sentence: 'avstyrkt att resultaträkningen och balansräkningen fastställs',
  },
  avstyrkt_rr: {
    modified: true,
    member: 'RevisorspateckningMeningAvstyrktAttResultatrakningFaststallsMember',
    sentence: 'avstyrkt att resultaträkningen fastställs',
  },
  avstyrkt_br: {
    modified: true,
    member: 'RevisorspateckningMeningAvstyrktAttBalansrakningFaststallsMember',
    sentence: 'avstyrkt att balansräkningen fastställs',
  },
  avstyrkt_rr_varken_br: {
    modified: true,
    member: 'RevisorspateckningMeningAvstyrktAttResultatrakningVarkenTillEllerAvstyrktBalansrakningFaststallsMember',
    sentence: 'avstyrkt att resultaträkningen fastställs och varken till- eller avstyrkt att balansräkningen fastställs',
  },
  avstyrkt_br_varken_rr: {
    modified: true,
    member: 'RevisorspateckningMeningAvstyrktAttBalanstrakningVarkenTillEllerAvstyrktResultatrakningFaststallsMember',
    sentence: 'avstyrkt att balansräkningen fastställs och varken till- eller avstyrkt att resultaträkningen fastställs',
  },
  varken_rr_br: {
    modified: true,
    member: 'RevisorspateckningMeningVarkenTillEllerAvstyrktAttResultatrakningBalansrakningFaststallsMember',
    sentence: 'varken till- eller avstyrkt att resultaträkningen och balansräkningen fastställs',
  },
  varken_rr: {
    modified: true,
    member: 'RevisorspateckningMeningVarkenTillEllerAvstyrktAttResultatrakningFaststallsMember',
    sentence: 'varken till- eller avstyrkt att resultaträkningen fastställs',
  },
  varken_br: {
    modified: true,
    member: 'RevisorspateckningMeningVarkenTillEllerAvstyrktAttBalansrakningFaststallsMember',
    sentence: 'varken till- eller avstyrkt att balansräkningen fastställs',
  },
}

/**
 * Whether the påteckning speaks in the plural: several revisors (ABL 9 kap.
 * 28 a §), or a revisionsbolag, which the official K3 example (faststalld
 * arsredovisning k3 exempel 3, 2021) writes as "Vår revisionsberättelse"
 * with one signing revisor.
 */
function plural(revisorCount: number, hasFirm: boolean): boolean {
  return revisorCount > 1 || hasFirm
}

/** "Min revisionsberättelse har lämnats", or "Vår" for several revisors or a firm. */
export function pateckningLead(revisorCount: number, hasFirm = false): string {
  return `${plural(revisorCount, hasFirm) ? 'Vår' : 'Min'} revisionsberättelse har lämnats`
}

/** The påteckningsmening ("Jag har i denna avstyrkt att ..."), or null. */
export function pateckningMening(opinion: AuditorOpinion | null, revisorCount: number, hasFirm = false): string | null {
  const sentence = opinion ? AUDITOR_OPINION_DEFINITIONS[opinion].sentence : null
  return sentence ? `${plural(revisorCount, hasFirm) ? 'Vi' : 'Jag'} har i denna ${sentence}.` : null
}

/**
 * The date of the påteckning: the revisionsberättelse is one document even
 * when several revisors sign it (28 a §), so the latest recorded date is the
 * day it was given. Null until every revisor's date is recorded.
 */
export function pateckningDatum(revisorer: ReadonlyArray<Pick<IxbrlRevisor, 'signedDate'>>): string | null {
  if (revisorer.length === 0 || revisorer.some((revisor) => !revisor.signedDate)) return null
  return revisorer.reduce<string>((latest, revisor) => (revisor.signedDate! > latest ? revisor.signedDate! : latest), '')
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] }
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] }
}

/** A roster row as every reader of the roster has it. */
export interface RosterRow {
  signer_name: string
  role: string
  signed_at: string | null
  status?: string
}

/** A locked version's roster row with the påteckning frozen on a signed revisor slot. */
export interface VersionPateckningRow {
  role: string
  signed_at: string | null
  pateckning_opinion?: string | null
  pateckning_firm_name?: string | null
}

/** The påteckning's facts that are not a person's: the revisionsbolag and the opinion. */
export interface PateckningFacts {
  firmName: string | null
  opinion: AuditorOpinion | null
}

/**
 * The påteckning facts a locked version shows, so that it renders as it was
 * signed (BFL 7 kap. 1 §):
 *
 *   - no revisor slot bound to the version: no påteckning, null, whatever
 *     the profile says now (a version locked before the revisor package, or
 *     for a company without revisor, renders as it was locked);
 *   - every revisor slot signed: the opinion and revisionsbolag frozen on the
 *     slots as the påteckning was given (workflow-service pateckningGate);
 *   - a revisor slot still pending: the profile as it stands, since the
 *     påteckning is not given yet (`profile` null reads as not answered).
 */
export function versionPateckningFacts(
  rows: readonly VersionPateckningRow[],
  profile: { auditor_firm_name: string | null; auditor_opinion: AuditorOpinion | null } | null,
): PateckningFacts | null {
  const revisorer = rows.filter((row) => isAuditorRole(row.role))
  if (revisorer.length === 0) return null
  if (revisorer.every((row) => row.signed_at)) {
    const frozen = revisorer.find((row) => row.pateckning_opinion) ?? revisorer[0]
    return {
      firmName: frozen.pateckning_firm_name?.trim() || null,
      opinion: (frozen.pateckning_opinion ?? null) as AuditorOpinion | null,
    }
  }
  return { firmName: profile?.auditor_firm_name?.trim() || null, opinion: profile?.auditor_opinion ?? null }
}

/** Board rows and revisor rows of a roster, declined slots dropped. */
export function splitRoster<T extends RosterRow>(rows: readonly T[]): { board: T[]; revisorer: T[] } {
  const active = rows.filter((row) => row.status !== 'declined')
  return {
    board: active.filter((row) => !isAuditorRole(row.role)),
    revisorer: active.filter((row) => isAuditorRole(row.role)),
  }
}

/**
 * Build the påteckning from the roster's revisor rows and the profile.
 * Returns null when no revisionsberättelse is required and no revisor is in
 * the roster: the document then has no påteckning at all.
 */
export function buildRevisorspateckning(
  revisorRows: readonly RosterRow[],
  profile: {
    auditor_report_required: boolean | null
    auditor_firm_name: string | null
    auditor_opinion: AuditorOpinion | null
  },
): IxbrlRevisorspateckning | null {
  const required = profile.auditor_report_required === true
  if (!required && revisorRows.length === 0) return null
  const firm = profile.auditor_firm_name?.trim() || null
  return {
    required,
    revisionsbolag: firm,
    opinion: profile.auditor_opinion ?? null,
    revisorer: revisorRows.map((row) => {
      const { firstName, lastName } = splitName(row.signer_name)
      return {
        firstName,
        lastName,
        titel: row.role.trim(),
        huvudansvarig: firm ? /^huvudansvarig revisor$/i.test(row.role.trim()) : null,
        signedDate: signatureDate(row.signed_at),
      }
    }),
  }
}
