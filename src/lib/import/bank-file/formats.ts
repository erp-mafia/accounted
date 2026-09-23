/**
 * Bank file format registry: which parsers exist and how a file is matched
 * to one. Split from parser.ts, which also hashes content with `crypto`,
 * so client code can resolve a format id to its label without the browser
 * crypto polyfill.
 */

import type { BankFileFormat, BankFileFormatId } from './types'
import { nordeaFormat } from './formats/nordea'
import { nordeaBusinessFormat } from './formats/nordea-business'
import { sebFormat } from './formats/seb'
import { swedbankFormat } from './formats/swedbank'
import { handelsbankenFormat } from './formats/handelsbanken'
import { lansforsakringarFormat } from './formats/lansforsakringar'
import { icaBankenFormat } from './formats/ica-banken'
import { skandiaFormat } from './formats/skandia'
import { lunarFormat } from './formats/lunar'
import { northmillFormat } from './formats/northmill'
import { wiseFormat } from './formats/wise'
import { wiseStatementFormat } from './formats/wise-statement'
import { camt053Format } from './formats/camt053'
import { genericCSVFormat } from './formats/generic-csv'

/**
 * Ordered list of format detectors.
 * camt.053 first (XML detection is unambiguous), then bank-specific CSV formats.
 * New bank formats go after existing ones but before generic_csv.
 * Generic CSV is last: it never auto-detects (manual fallback only).
 */
const FORMATS: BankFileFormat[] = [
  camt053Format,
  nordeaFormat,
  nordeaBusinessFormat,
  sebFormat,
  swedbankFormat,
  handelsbankenFormat,
  lansforsakringarFormat,
  icaBankenFormat,
  skandiaFormat,
  lunarFormat,
  northmillFormat,
  wiseFormat,
  wiseStatementFormat,
  genericCSVFormat,
]

/**
 * Get a format by its ID
 */
export function getFormat(id: BankFileFormatId): BankFileFormat | undefined {
  return FORMATS.find((f) => f.id === id)
}

/**
 * Get all available formats
 */
export function getAllFormats(): BankFileFormat[] {
  return FORMATS
}

/**
 * Auto-detect the bank file format from content and filename
 *
 * Returns the first matching format, or null if no format matches.
 * Uses filename extension as a hint (e.g. .xml for camt.053).
 */
export function detectFileFormat(content: string, filename: string): BankFileFormat | null {
  for (const format of FORMATS) {
    if (format.detect(content, filename)) {
      return format
    }
  }
  return null
}
