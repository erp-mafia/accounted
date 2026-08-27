/**
 * Bank file parser: main entry point
 *
 * Auto-detects Swedish bank file formats and parses to normalized transactions.
 * Supports Nordea, SEB, Swedbank, Handelsbanken CSV and ISO 20022 camt.053 XML.
 */

import * as crypto from 'crypto'
import type { BankFileFormat, BankFileFormatId, BankFileParseResult, ParsedBankTransaction } from './types'

// The format registry and detection live in ./formats (no Node imports) so
// client components (BankFileImportHistory) can name a format without
// pulling this module's `crypto` import into the browser bundle.
import { detectFileFormat, getAllFormats, getFormat } from './formats'
export { detectFileFormat, getAllFormats, getFormat } from './formats'

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
        issues: [{ row: 0, message: `Okänt format: ${formatId}`, severity: 'error' }],
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    const explicitResult = format.parse(content)
    if (explicitResult.transactions.length > 0 || formatId === 'generic_csv') {
      // A working explicit parse is never overridden. generic_csv is also
      // exempt: it is the manual column-mapping escape hatch and its default
      // mapping legitimately parses 0 rows before the user maps columns.
      return explicitResult
    }

    // The explicit choice parsed nothing: fall back to auto-detection so an
    // explicitly selected bank is never WORSE than "Automatisk identifiering".
    // detectFileFormat can never return generic_csv (its detect() is always
    // false), so this cannot reroute the UI into the mapping flow.
    const detected = detectFileFormat(content, filename)
    if (detected && detected.id !== formatId) {
      const detectedResult = detected.parse(content)
      if (detectedResult.transactions.length > 0) {
        return {
          ...detectedResult,
          issues: [
            {
              row: 0,
              message: `Filen matchade inte det valda formatet (${format.name}) och tolkades istället som ${detected.name}.`,
              severity: 'info',
            },
            ...detectedResult.issues,
          ],
        }
      }
    }

    return explicitResult
  } else {
    format = detectFileFormat(content, filename) || undefined
    if (!format) {
      // Build diagnostic message listing which formats were tried
      const tried = getAllFormats()
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

  // Wise carries the stable transfer ID (TRANSFER-…, PLAN_ORDER-…, plus a
  // `-fee` suffix for fee rows) in raw_line: use it so re-importing the same
  // statement dedups exactly instead of relying on the row hash.
  if (formatId === 'wise' && tx.raw_line) {
    return `wise_${tx.raw_line}`
  }

  if (formatId === 'wise_statement' && tx.raw_line) {
    return `wise_${tx.raw_line}`
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
