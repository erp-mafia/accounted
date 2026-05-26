/**
 * Bank file parser — main entry point
 *
 * Auto-detects Swedish bank file formats and parses to normalized transactions.
 * Supports Nordea, SEB, Swedbank, Handelsbanken CSV and ISO 20022 camt.053 XML.
 */

import * as crypto from 'crypto'
import type { BankFileFormat, BankFileFormatId, BankFileParseResult, ParsedBankTransaction } from './types'
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
import { camt053Format } from './formats/camt053'
import { genericCSVFormat } from './formats/generic-csv'

/**
 * Ordered list of format detectors.
 * camt.053 first (XML detection is unambiguous), then bank-specific CSV formats.
 * New bank formats go after existing ones but before generic_csv.
 * Generic CSV is last — it never auto-detects (manual fallback only).
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

/**
 * Parse a bank file with auto-detection or explicit format
 *
 * @param content - File content as string (already decoded)
 * @param filename - Original filename (used for format detection hints)
 * @param formatId - Optional explicit format to use (skips auto-detection)
 */
export function parseBankFile(
  content: string,
  filename: string,
  formatId?: BankFileFormatId
): BankFileParseResult {
  let format: BankFileFormat | undefined

  if (formatId) {
    format = getFormat(formatId)
    if (!format) {
      return {
        format: formatId,
        format_name: 'Unknown',
        transactions: [],
        date_from: null,
        date_to: null,
        issues: [{ row: 0, message: `Unknown format: ${formatId}`, severity: 'error' }],
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }
  } else {
    format = detectFileFormat(content, filename) || undefined
    if (!format) {
      // Build diagnostic message listing which formats were tried
      const tried = FORMATS
        .filter(f => f.id !== 'generic_csv')
        .map(f => f.name)
      const firstLine = content.split('\n')[0]?.substring(0, 80) || ''
      return {
        format: 'generic_csv',
        format_name: 'Unknown',
        transactions: [],
        date_from: null,
        date_to: null,
        issues: [{
          row: 0,
          message: `Kunde inte identifiera bankformat. Testade: ${tried.join(', ')}. Första raden: "${firstLine}". Välj bank manuellt eller använd "Annan CSV".`,
          severity: 'error',
        }],
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }
  }

  return format.parse(content)
}

/**
 * Generate a stable external_id for a parsed bank transaction.
 *
 * For CSV files: SHA-256 of (format + date + description + amount + row_index)
 * For camt.053: Uses the entry reference from the XML if available
 *
 * Two identical transactions on the same day will get different IDs due to row_index.
 */
export function generateExternalId(
  tx: ParsedBankTransaction,
  formatId: BankFileFormatId,
  rowIndex: number
): string {
  // For camt.053, prefer the raw_line which contains the entry reference
  if (formatId === 'camt053' && tx.raw_line && !tx.raw_line.startsWith('camt053_entry_')) {
    return `camt053_${tx.raw_line}`
  }

  // For CSV formats, create a composite hash
  const composite = `${formatId}|${tx.date}|${tx.description}|${tx.amount}|${rowIndex}`
  const hash = crypto.createHash('sha256').update(composite).digest('hex').substring(0, 16)
  return `${formatId}_${hash}`
}

/**
 * Generate a file hash for dedup of the same file being uploaded twice
 */
export function generateFileHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}
