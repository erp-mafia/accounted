import { getBranding } from '@/lib/branding/service'
import { sruDate, sruTime } from './format'

/**
 * The SRU file envelope shared by the INK2 and NE-bilaga generators: line
 * endings, text sanitising, the blankett type's income year and period
 * suffix, and INFO.SRU. Per Skatteverket's "Teknisk information om
 * filöverföring" as summarised in .claude/skills/swedish-sru-filing
 * (references/file-format.md §1 INFO.SRU, §2 blankett type and period
 * suffix). ISO 8859-1 encoding is applied by the routes when they write the
 * files (encodeISO88591).
 */

export const SRU_CRLF = '\r\n'
const PROGRAM_VERSION = '1.0'

/** A file's lines, CRLF-terminated. */
export function sruFile(lines: readonly string[]): string {
  return lines.join(SRU_CRLF) + SRU_CRLF
}

/** Text for an SRU post: '#' is reserved, line breaks become spaces, at most 250 characters (STR_250). */
export function sruText(str: string): string {
  return str.replace(/#/g, '').replace(/[\r\n]/g, ' ').substring(0, 250)
}

/** The income year (inkomstår): the calendar year the räkenskapsår ends in. */
export function sruIncomeYear(fiscalYearEnd: string): string {
  return fiscalYearEnd.substring(0, 4)
}

/**
 * The blankett type's period suffix, from the month the räkenskapsår ENDS in
 * (file-format.md §2, "Period suffix rules"):
 *   P1 January-April, P2 May-June, P3 July-August, P4 September-December.
 */
export function sruPeriodSuffix(fiscalYearEnd: string): 'P1' | 'P2' | 'P3' | 'P4' {
  const endMonth = parseInt(fiscalYearEnd.substring(5, 7), 10)
  if (endMonth >= 1 && endMonth <= 4) return 'P1'
  if (endMonth >= 5 && endMonth <= 6) return 'P2'
  if (endMonth >= 7 && endMonth <= 8) return 'P3'
  return 'P4'
}

/** The blankett type, e.g. `INK2R-2025P4` for a räkenskapsår ending 2025-12-31. */
export function sruBlankettType(form: string, fiscalYearEnd: string): string {
  return `${form}-${sruIncomeYear(fiscalYearEnd)}${sruPeriodSuffix(fiscalYearEnd)}`
}

/** Who files: the #MEDIELEV posts of INFO.SRU. */
export interface SruSubmitter {
  /** 12 digits: org number with the 16 prefix, or a personnummer. */
  identity12: string
  name: string
  addressLine1?: string | null
  postalCode?: string | null
  city?: string | null
  email?: string | null
}

/**
 * INFO.SRU, posts in the prescribed order (file-format.md §1). Mandatory
 * posts: #PRODUKT, #FILNAMN, #ORGNR, #NAMN, #POSTNR, #POSTORT. #POSTNR is the
 * 5-digit postal code, so a "111 22" written with a space loses it.
 */
export function buildInfoSru(submitter: SruSubmitter, now: Date): string {
  const lines: string[] = []

  lines.push('#DATABESKRIVNING_START')
  lines.push('#PRODUKT SRU')
  lines.push(`#SKAPAD ${sruDate(now)} ${sruTime(now)}`)
  lines.push(`#PROGRAM ${sruText(getBranding().appName.toLowerCase())} ${PROGRAM_VERSION}`)
  lines.push('#FILNAMN BLANKETTER.SRU')
  lines.push('#DATABESKRIVNING_SLUT')

  lines.push('#MEDIELEV_START')
  lines.push(`#ORGNR ${submitter.identity12}`)
  lines.push(`#NAMN ${sruText(submitter.name)}`)
  if (submitter.addressLine1) {
    lines.push(`#ADRESS ${sruText(submitter.addressLine1)}`)
  }
  lines.push(`#POSTNR ${(submitter.postalCode || '00000').replace(/\s/g, '')}`)
  lines.push(`#POSTORT ${sruText(submitter.city || 'Okänd')}`)
  if (submitter.email) {
    lines.push(`#EMAIL ${sruText(submitter.email)}`)
  }
  lines.push('#MEDIELEV_SLUT')

  return sruFile(lines)
}
