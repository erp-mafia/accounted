import { sruAmount as formatAmount, sruDate as formatDate, sruTime as formatTime } from '@/lib/reports/sru/format'
import { buildInfoSru, sruBlankettType, sruFile, sruText } from '@/lib/reports/sru/envelope'
import { toRedovisare12 } from '@/lib/invariants/org-number'
import type {
  INK2Declaration,
  INK2RSRUCode,
  INK2SRutor,
  SRUSubmission,
} from './types'
import {
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2R_INCOME_CODES,
} from './types'

/**
 * SRU File Generator for INK2 (Aktiebolag)
 *
 * Generates a Skatteverket-compliant SRU submission consisting of:
 *   - INFO.SRU: submitter metadata
 *   - BLANKETTER.SRU: three blankett blocks (INK2, INK2R, INK2S)
 *
 * The envelope (line endings, sanitising, blankett type, INFO.SRU) is shared
 * with the NE-bilaga: lib/reports/sru/envelope.ts.
 * Encoding: ISO 8859-1 (handled by the API route when writing the response)
 * Amounts: integers in hela kronor, no decimals, no thousands separators
 * Org number: 12 digits with century prefix 16 for juridisk person
 * (toRedovisare12, the one conversion every filing shares)
 */

/**
 * Generate the BLANKETTER.SRU file content with three blankett blocks
 */
function generateBlanketterSru(declaration: INK2Declaration, now: Date, orgNumber12: string): string {
  const lines: string[] = []

  const fiscalYearEnd = declaration.fiscalYear.end
  const companyName = sruText(declaration.companyInfo.companyName)
  const dateStr = formatDate(now)

  // Each blankett gets a unique timestamp (increment seconds)
  const time0 = formatTime(now)
  const time1 = formatTime(new Date(now.getTime() + 1000))
  const time2 = formatTime(new Date(now.getTime() + 2000))

  // ---- Block 1: INK2 (huvudblankett) ----
  lines.push(`#BLANKETT ${sruBlankettType('INK2', fiscalYearEnd)}`)
  lines.push(`#IDENTITET ${orgNumber12} ${dateStr} ${time0}`)
  lines.push(`#NAMN ${companyName}`)

  // Fiscal year dates
  lines.push(`#UPPGIFT 7011 ${declaration.ink2['7011']}`)
  lines.push(`#UPPGIFT 7012 ${declaration.ink2['7012']}`)

  // Överskott/underskott
  if (declaration.ink2['7104'] > 0) {
    lines.push(`#UPPGIFT 7104 ${formatAmount(declaration.ink2['7104'])}`)
  }
  if (declaration.ink2['7114'] > 0) {
    lines.push(`#UPPGIFT 7114 ${formatAmount(declaration.ink2['7114'])}`)
  }
  // Underlag för särskild löneskatt på pensionskostnader (1.4) and a
  // negative underlag (1.5).
  if (declaration.ink2['7132'] > 0) {
    lines.push(`#UPPGIFT 7132 ${formatAmount(declaration.ink2['7132'])}`)
  }
  if (declaration.ink2['7133'] > 0) {
    lines.push(`#UPPGIFT 7133 ${formatAmount(declaration.ink2['7133'])}`)
  }

  lines.push('#BLANKETTSLUT')

  // ---- Block 2: INK2R (räkenskapsschema) ----
  lines.push(`#BLANKETT ${sruBlankettType('INK2R', fiscalYearEnd)}`)
  lines.push(`#IDENTITET ${orgNumber12} ${dateStr} ${time1}`)
  lines.push(`#NAMN ${companyName}`)

  // Fiscal year dates
  lines.push(`#UPPGIFT 7011 ${declaration.ink2['7011']}`)
  lines.push(`#UPPGIFT 7012 ${declaration.ink2['7012']}`)

  // All INK2R fields in canonical Skatteverket order: emit non-zero values only
  const ink2rCodes: INK2RSRUCode[] = [
    ...INK2R_ASSET_CODES,
    ...INK2R_EQUITY_LIABILITY_CODES,
    ...INK2R_INCOME_CODES,
  ]
  for (const code of ink2rCodes) {
    const value = declaration.ink2r[code]
    if (value !== 0) {
      lines.push(`#UPPGIFT ${code} ${formatAmount(value)}`)
    }
  }

  lines.push('#BLANKETTSLUT')

  // ---- Block 3: INK2S (skattemässiga justeringar) ----
  lines.push(`#BLANKETT ${sruBlankettType('INK2S', fiscalYearEnd)}`)
  lines.push(`#IDENTITET ${orgNumber12} ${dateStr} ${time2}`)
  lines.push(`#NAMN ${companyName}`)

  // Fiscal year dates
  lines.push(`#UPPGIFT 7011 ${declaration.ink2s['7011']}`)
  lines.push(`#UPPGIFT 7012 ${declaration.ink2s['7012']}`)

  // INK2S numeric fields: emit non-zero values only
  const ink2sNumericFields: (keyof INK2SRutor)[] = [
    '7650',
    '7750',
    '7651',
    '7652',
    '7653',
    '7753',
    '7754',
    '7654',
    '7673',
    '7666',
    '7765',
    '7763',
    '7670',
    '7770',
  ]
  for (const code of ink2sNumericFields) {
    const value = declaration.ink2s[code]
    if (typeof value === 'number' && value !== 0) {
      lines.push(`#UPPGIFT ${code} ${formatAmount(value)}`)
    }
  }

  lines.push('#BLANKETTSLUT')

  // Required terminator
  lines.push('#FIL_SLUT')

  return sruFile(lines)
}

/**
 * The declaration has sruBlockers: the books or the mapping must be corrected
 * before a file can exist, so every door answers it as a 422, not a
 * generation failure (the NE-bilaga's NESruBlockedError, the same rule).
 */
export class Ink2SruBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join(' '))
    this.name = 'Ink2SruBlockedError'
  }
}

/**
 * Generate complete SRU submission (INFO.SRU + BLANKETTER.SRU)
 */
export function generateSRUSubmission(declaration: INK2Declaration): SRUSubmission {
  // A form that does not tie to the books would file figures that are not
  // the company's. Every SRU door builds here, so this refuses them all.
  if (declaration.sruBlockers.length > 0) {
    throw new Ink2SruBlockedError(declaration.sruBlockers)
  }
  const now = new Date()
  const info = declaration.companyInfo
  const identity12 = toRedovisare12(info.orgNumber ?? '', info.entityType)

  return {
    infoSru: buildInfoSru(
      {
        identity12,
        name: info.companyName,
        addressLine1: info.addressLine1,
        postalCode: info.postalCode,
        city: info.city,
        email: info.email,
      },
      now,
    ),
    blanketterSru: generateBlanketterSru(declaration, now, identity12),
    generatedAt: now.toISOString(),
  }
}

/**
 * Get ZIP filename for download
 */
export function getZipFilename(declaration: INK2Declaration): string {
  const year = declaration.fiscalYear.start.substring(0, 4)
  const orgNumber = declaration.companyInfo.orgNumber?.replace(/-/g, '') || 'unknown'
  return `INK2_SRU_${orgNumber}_${year}.zip`
}
