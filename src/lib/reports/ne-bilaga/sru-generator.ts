import { buildInfoSru, sruBlankettType, sruFile, sruIncomeYear, sruText } from '@/lib/reports/sru/envelope'
import { sruAmount as formatAmount, sruDate as formatDate, sruTime as formatTime } from '@/lib/reports/sru/format'
import { FilingIdentityError, swedishNumberKind, toRedovisare12 } from '@/lib/invariants/org-number'
import type { NEBalansRutor, NEDeclaration, NEDeclarationRutor, SRUSubmission } from '@/lib/reports/ne-bilaga/types'

/**
 * SRU File Generator for NE-bilaga (enskild näringsidkare)
 *
 * Generates a Skatteverket-compliant SRU submission consisting of two files:
 *   - INFO.SRU:       submitter metadata (who is filing)
 *   - BLANKETTER.SRU: a single NE blankett block with the balansräkning
 *                     (B1-B16), the räkenskapsschema (R1-R11) and R12
 *
 * The NE-bilaga is an appendix to Inkomstdeklaration 1 (INK1) filed by a physical
 * person, so the identifier is the owner's PERSONNUMMER (12-digit YYYYMMDDNNNN,
 * toRedovisare12): NOT a juridisk-person org number with the "16" century prefix
 * used by INK2. A number that is not a person's has no such identity: refused.
 *
 * The envelope (line endings, sanitising, blankett type, INFO.SRU) is shared
 * with INK2: lib/reports/sru/envelope.ts.
 * Encoding: ISO 8859-1 (applied by the API route via encodeISO88591).
 * Amounts: integers in hela kronor (öre truncated per SFL 22:1).
 *
 * Field codes (Fältkod -> Rad NE) are taken from BAS-kontogruppen's official
 * coupling table "NE - Inkomst av näringsverksamhet, Enskilda näringsidkare"
 * (bas.se/kontoplaner/sru/). Confirmed against the BAS NE_EJ_K1 kopplingstabell:
 *   R1 7400 · R2 7401 · R3 7402 · R4 7403 · R5 7500 · R6 7501 · R7 7502 ·
 *   R8 7503 · R9 7504 · R10 7505 · R11 7440. Period dates: 7011 (start) / 7012 (end).
 */

/** Räkenskapsårets start-/slutdatum (standard period date fält, shared across blanketter). */
const FISCAL_START_CODE = '7011'
const FISCAL_END_CODE = '7012'

/** Authoritative NE-bilaga räkenskapsschema field codes (BAS kopplingstabell NE_EJ_K1). */
/**
 * NE-bilaga balansräkning field codes, Skatteverket's field-name table
 * (official-ne-fields.json, 2025P4 and 2026P4 alike).
 */
export const NE_BALANS_FIELD_CODES: Record<keyof NEBalansRutor, string> = {
  B1: '7200',
  B2: '7210',
  B3: '7211',
  B4: '7212',
  B5: '7213',
  B6: '7240',
  B7: '7250',
  B8: '7260',
  B9: '7280',
  B10: '7300',
  B11: '7320',
  B12: '7330',
  B13: '7380',
  B14: '7381',
  B15: '7382',
  B16: '7383',
}

/** R12, sida 2: the booked result carried over from R11. */
export const R12_FIELD_CODE = '7600'
/** R13 and R14, sida 2: both filed as positive amounts; the form adds R13 and subtracts R14. */
export const R13_FIELD_CODE = '7601'
export const R14_FIELD_CODE = '7700'

export const NE_SRU_FIELD_CODES: Record<keyof NEDeclarationRutor, string> = {
  R1: '7400', // Försäljning och utfört arbete samt övriga momspliktiga intäkter
  R2: '7401', // Momsfria intäkter
  R3: '7402', // Bil- och bostadsförmån m.m.
  R4: '7403', // Ränteintäkter m.m.
  R5: '7500', // Varor och legoarbeten
  R6: '7501', // Övriga externa kostnader
  R7: '7502', // Anställd personal
  R8: '7503', // Räntekostnader m.m.
  R9: '7504', // Avskrivningar och nedskrivningar byggnader och markanläggningar
  R10: '7505', // Avskrivningar och nedskrivningar maskiner/inventarier/immateriella tillgångar
  R11: '7440', // Bokfört resultat
}

/** Convert a YYYY-MM-DD string to SRU date format YYYYMMDD. */
function dateStringToSRU(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

/** Generate the BLANKETTER.SRU file content (a single NE blankett block). */
function generateBlanketterSru(declaration: NEDeclaration, now: Date, identity12: string): string {
  const lines: string[] = []
  const taxpayerName = sruText(declaration.companyInfo.companyName)

  lines.push(`#BLANKETT ${sruBlankettType('NE', declaration.fiscalYear.end)}`)
  lines.push(`#IDENTITET ${identity12} ${formatDate(now)} ${formatTime(now)}`)
  lines.push(`#NAMN ${taxpayerName}`)

  // Räkenskapsårets datum
  lines.push(`#UPPGIFT ${FISCAL_START_CODE} ${dateStringToSRU(declaration.fiscalYear.start)}`)
  lines.push(`#UPPGIFT ${FISCAL_END_CODE} ${dateStringToSRU(declaration.fiscalYear.end)}`)

  // Balansräkning B1-B16, then rutor R1-R11 and R12 (the result carried to
  // sida 2), in the field table's order: non-zero values only (zero/empty
  // fields must be omitted). Sida 2 from R13 on is completed in Skatteverket's
  // e-tjänst after the import.
  for (const [ruta, code] of Object.entries(NE_BALANS_FIELD_CODES) as Array<[keyof NEBalansRutor, string]>) {
    const value = declaration.balans[ruta]
    if (value !== 0) {
      lines.push(`#UPPGIFT ${code} ${formatAmount(value)}`)
    }
  }
  const rutaOrder: (keyof NEDeclarationRutor)[] = [
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11',
  ]
  for (const ruta of rutaOrder) {
    const value = declaration.rutor[ruta]
    if (value !== 0) {
      lines.push(`#UPPGIFT ${NE_SRU_FIELD_CODES[ruta]} ${formatAmount(value)}`)
    }
  }
  if (declaration.rutor.R11 !== 0) {
    lines.push(`#UPPGIFT ${R12_FIELD_CODE} ${formatAmount(declaration.rutor.R11)}`)
  }
  if (declaration.sida2.R13 > 0) {
    lines.push(`#UPPGIFT ${R13_FIELD_CODE} ${formatAmount(declaration.sida2.R13)}`)
  }
  if (declaration.sida2.R14 > 0) {
    lines.push(`#UPPGIFT ${R14_FIELD_CODE} ${formatAmount(declaration.sida2.R14)}`)
  }

  lines.push('#BLANKETTSLUT')
  lines.push('#FIL_SLUT')

  return sruFile(lines)
}

/**
 * The declaration has sruBlockers: the books must be corrected before a file
 * can exist, so both doors answer it as a 422, not a generation failure.
 */
export class NESruBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join(' '))
    this.name = 'NESruBlockedError'
  }
}

/** Generate a complete SRU submission (INFO.SRU + BLANKETTER.SRU) for the NE-bilaga. */
export function generateNESRUSubmission(declaration: NEDeclaration): SRUSubmission {
  // An account outside every ruta, or an R11 that differs from the booked
  // result, would file a näringsverksamhet that is not the one in the books.
  // Both SRU downloads (dashboard and v1) build here, so this refuses both.
  if (declaration.sruBlockers.length > 0) {
    throw new NESruBlockedError(declaration.sruBlockers)
  }

  const now = new Date()
  const { orgNumber, entityType } = declaration.companyInfo

  // A valid NE filing requires the owner's personnummer. Refuse rather than ship a
  // structurally well-formed file with a placeholder #IDENTITET that Skatteverket
  // would reject at upload. toRedovisare12 passes a legal person's number, and an
  // NE has no such filer, so this door asks for a person itself.
  if (!orgNumber || swedishNumberKind(orgNumber) !== 'person') throw new FilingIdentityError()
  const identity12 = toRedovisare12(orgNumber, entityType)

  return {
    infoSru: buildInfoSru(
      {
        identity12,
        name: declaration.companyInfo.companyName,
        addressLine1: declaration.companyInfo.addressLine1,
        postalCode: declaration.companyInfo.postalCode,
        city: declaration.companyInfo.city,
        email: declaration.companyInfo.email,
      },
      now,
    ),
    blanketterSru: generateBlanketterSru(declaration, now, identity12),
    generatedAt: now.toISOString(),
  }
}

/** Get the ZIP filename for download. Uses the income year (fiscal year END) so the
 * filename matches the blankett type/identity for broken fiscal years. */
export function getZipFilename(declaration: NEDeclaration): string {
  const year = sruIncomeYear(declaration.fiscalYear.end)
  const orgNumber = declaration.companyInfo.orgNumber?.replace(/\D/g, '') || 'unknown'
  return `NE_SRU_${orgNumber}_${year}.zip`
}
