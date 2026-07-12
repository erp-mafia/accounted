import { VAT_RUTA_LABELS, type VatDeclarationRutor } from '@/types'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'

/**
 * Maps each momsdeklaration ruta to its eSKDUpload XML tag, per Skatteverket's
 * "Skapa en fil" specification (dev_docs/skatteverket/moms). The tag order in
 * the emitted file follows the ruta order defined below, which matches the SKV
 * form/file layout. ruta49 (MomsBetala) is the mandatory summering and is always
 * emitted last.
 */
const RUTA_TO_ESKD_TAG: Record<keyof VatDeclarationRutor, string> = {
  ruta05: 'ForsMomsEjAnnan',
  ruta06: 'UttagMoms',
  ruta07: 'UlagMargbesk',
  ruta08: 'HyrinkomstFriv',
  ruta10: 'MomsUtgHog',
  ruta11: 'MomsUtgMedel',
  ruta12: 'MomsUtgLag',
  ruta20: 'InkopVaruAnnatEg',
  ruta21: 'InkopTjanstAnnatEg',
  ruta22: 'InkopTjanstUtomEg',
  ruta23: 'InkopVaruSverige',
  ruta24: 'InkopTjanstSverige',
  ruta30: 'MomsInkopUtgHog',
  ruta31: 'MomsInkopUtgMedel',
  ruta32: 'MomsInkopUtgLag',
  ruta35: 'ForsVaruAnnatEg',
  ruta36: 'ForsVaruUtomEg',
  ruta37: 'InkopVaruMellan3p',
  ruta38: 'ForsVaruMellan3p',
  ruta39: 'ForsTjSkskAnnatEg',
  ruta40: 'ForsTjOvrUtomEg',
  ruta41: 'ForsKopareSkskSverige',
  ruta42: 'ForsOvrigt',
  // Import block: beskattningsunderlag (50) then output VAT (60/61/62).
  ruta50: 'MomsUlagImport',
  ruta60: 'MomsImportUtgHog',
  ruta61: 'MomsImportUtgMedel',
  ruta62: 'MomsImportUtgLag',
  ruta48: 'MomsIngAvdr',
  ruta49: 'MomsBetala',
}

// Emission order: the RUTA_TO_ESKD_TAG key order, which encodes the SKV file
// spec's radnummer sequence. Notably the import block (ruta 50/60/61/62,
// rad 29-32) comes BEFORE MomsIngAvdr (ruta 48, rad 33); a numeric ruta sort
// would invert that and produce a file SKV rejects (avvisande fel). ruta49
// (MomsBetala) is the mandatory summering and is emitted last by the builder.
const EMIT_ORDER: (keyof VatDeclarationRutor)[] = (
  Object.keys(RUTA_TO_ESKD_TAG) as (keyof VatDeclarationRutor)[]
).filter((key) => key !== 'ruta49')

export interface ESkdFileInput {
  /** Company org/person number, any format; digits are extracted and re-formatted. */
  orgNumber: string
  /**
   * The declaration period's END date (YYYY-MM-DD). The eSKD <Period> is the
   * year plus the last month of the period (YYYYMM): for monthly that is the
   * month itself, for quarterly the last month of the quarter, for a full
   * beskattningsår the last month of the fiscal year. Deriving it from the end
   * date handles all three uniformly.
   */
  periodEnd: string
}

/**
 * Formats a Swedish org/person number as `xxxxxx-xxxx` (10 digits with hyphen),
 * as required by the eSKD header. Accepts 12-digit century-prefixed values
 * (16xxxxxxxxxx org numbers, 19/20-prefixed personnummer) by stripping the
 * prefix, mirroring formatRedovisare/formatOrgNumber12; settings rows predating
 * org-number normalization legitimately hold 12 digits. Throws otherwise, since
 * an out-of-format OrgNr is an "avvisande fel" that Skatteverket rejects outright.
 */
function formatESkdOrgNumber(orgNumber: string): string {
  let digits = orgNumber.replace(/\D/g, '')
  if (digits.length === 12) digits = digits.slice(2)
  if (digits.length !== 10) {
    throw new Error(
      `Ogiltigt organisationsnummer för momsdeklaration (kräver 10 siffror): ${orgNumber}`,
    )
  }
  return `${digits.slice(0, 6)}-${digits.slice(6)}`
}

/** Derives the eSKD <Period> value (YYYYMM) from the period end date. */
function toESkdPeriod(periodEnd: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodEnd)
  if (!match) {
    throw new Error(`Ogiltigt periodslutdatum för momsdeklaration: ${periodEnd}`)
  }
  return `${match[1]}${match[2]}`
}

/**
 * Builds the Skatteverket eSKDUpload (v6.0) momsdeklaration file from the
 * calculated rutor. This is the file a user uploads under "Deklarera via fil";
 * unlike the PDF (a read/record copy) this is a real submission artifact.
 *
 * Format rules (dev_docs/skatteverket/moms/momsdeklaration_via_etjänst.txt):
 * - Whole kronor only, no decimals; öre are truncated (shared with the PDF via
 *   buildFiledAmounts so the two documents always tie out).
 * - Only rutor with a value are emitted, except <MomsBetala> (ruta49) which is
 *   the mandatory summering and is always present.
 * - A refund is written with a leading minus directly before the amount; no
 *   leading plus is ever emitted.
 * - Declared encoding is ISO-8859-1. The content is effectively ASCII (tags,
 *   digits, hyphen), so no non-ASCII bytes appear; the caller still encodes as
 *   latin1 to honour the declared charset.
 * - CRLF line endings.
 *
 * @returns the XML string. Encode with Buffer.from(xml, 'latin1') before serving.
 */
export function buildESkdFile(rutor: VatDeclarationRutor, input: ESkdFileInput): string {
  const orgNr = formatESkdOrgNumber(input.orgNumber)
  const period = toESkdPeriod(input.periodEnd)
  const { amounts } = buildFiledAmounts(rutor)

  const lines: string[] = [
    '<?xml version="1.0" encoding="ISO-8859-1"?>',
    '<eSKDUpload Version="6.0">',
    `<OrgNr>${orgNr}</OrgNr>`,
    '<Moms>',
    `<Period>${period}</Period>`,
  ]

  for (const key of EMIT_ORDER) {
    const amount = amounts[key]
    if (amount === 0) continue // omit empty rutor; MomsBetala is emitted below
    lines.push(`<${RUTA_TO_ESKD_TAG[key]}>${amount}</${RUTA_TO_ESKD_TAG[key]}>`)
  }

  // ruta49 (MomsBetala) is always emitted, even when 0 (Exempel 3: inget att
  // deklarera). A refund keeps its leading minus from the signed net.
  lines.push(`<MomsBetala>${amounts.ruta49}</MomsBetala>`)

  lines.push('</Moms>')
  lines.push('</eSKDUpload>')

  return lines.join('\r\n') + '\r\n'
}

// Re-exported for tests and any caller that needs the tag mapping directly.
export { RUTA_TO_ESKD_TAG, VAT_RUTA_LABELS }
