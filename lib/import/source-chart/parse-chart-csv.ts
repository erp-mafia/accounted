/**
 * Parser for a source accounting system's chart-of-accounts CSV export.
 *
 * SIE4 carries no VAT codes, so the guided import has only the account label to
 * go on and a label regex is the ceiling. A chart export from the system being
 * left behind usually does carry them, which is what this reads.
 *
 * Written against Spiris exports, which are UTF-8 with a BOM, semicolon
 * separated and CRLF terminated. All three are traps: the BOM corrupts the
 * first column name if the caller does not strip it, semicolon is nobody's
 * default, and a lone CR left on the last field silently breaks equality
 * comparisons. Columns are looked up by header NAME rather than position, so a
 * reordered or extended export keeps working.
 */

/** One account as the source system's chart export describes it. */
export interface SourceChartAccount {
  accountNumber: string
  accountName: string
  /** The source system's verbatim VAT code, or null when the export leaves it blank. */
  vatCode: string | null
  /**
   * Whether the source system still offers the account for posting. Spiris
   * ships its full chart (1 300+ rows) and marks the unused ones inactive, so
   * this is the difference between "the company's chart" and "every account
   * the vendor knows about".
   */
  isActive: boolean
}

export interface ParsedSourceChart {
  accounts: SourceChartAccount[]
  /** Problems worth showing the user; never thrown, so a partial file still helps. */
  warnings: string[]
}

const HEADER_ACCOUNT_NUMBER = 'AccountNumber'
const HEADER_ACCOUNT_NAME = 'AccountName'
const HEADER_VAT_CODE = 'VatCodeAndPercent'
const HEADER_IS_ACTIVE = 'IsActive'

/**
 * Split one CSV line on semicolons, honouring double-quoted fields.
 *
 * Deliberately small rather than a dependency: the only quoting this format
 * uses is a field wrapped in double quotes, with a doubled quote for a literal
 * one. Account names carrying a semicolon are the case that makes a plain
 * split wrong.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (inQuotes) {
      if (char !== '"') {
        field += char
      } else if (line[i + 1] === '"') {
        field += '"'
        i++
      } else {
        inQuotes = false
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === ';') {
      fields.push(field)
      field = ''
      continue
    }
    field += char
  }
  fields.push(field)
  return fields
}

/** True for the spellings Spiris writes into a boolean column. */
function isTrue(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'ja'
}

export function parseSourceChartCsv(content: string): ParsedSourceChart {
  const warnings: string[] = []
  // Strip the BOM before anything reads the first header, or the first column
  // is named "﻿IsActive" and never matches.
  const text = content.replace(/^﻿/, '')
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '')

  if (lines.length === 0) {
    return { accounts: [], warnings: ['Filen är tom.'] }
  }

  const header = splitCsvLine(lines[0]).map((h) => h.trim())
  const columnOf = (name: string) => header.indexOf(name)

  const numberAt = columnOf(HEADER_ACCOUNT_NUMBER)
  const nameAt = columnOf(HEADER_ACCOUNT_NAME)
  const vatAt = columnOf(HEADER_VAT_CODE)
  const activeAt = columnOf(HEADER_IS_ACTIVE)

  if (numberAt === -1 || nameAt === -1) {
    // A comma-separated file parses as a single column, which is the most
    // likely reason to land here, so say so instead of naming the columns.
    // Name the system, not the columns. This parser reads one export format,
    // and a file that fails here is far more likely to be a correct chart from
    // a system we do not read yet than a broken Spiris file; telling its owner
    // that AccountNumber is missing sends them looking for a fault in a file
    // that has none.
    const looksCommaSeparated = header.length === 1 && header[0].includes(',')
    warnings.push(
      looksCommaSeparated
        ? 'Filen är kommaseparerad. Spiris Bokföring exporterar semikolonseparerat, så den här kommer troligen från ett annat system, och de formaten stöds inte än.'
        : 'Filen ser inte ut som en kontoplansexport från Spiris Bokföring. Andra system exporterar i andra format, och de stöds inte än.',
    )
    return { accounts: [], warnings }
  }

  if (vatAt === -1) {
    warnings.push(
      `Kolumnen ${HEADER_VAT_CODE} saknas, så inga momskoder kan hämtas ur filen.`,
    )
  }

  const accounts: SourceChartAccount[] = []
  const seen = new Set<string>()
  let malformed = 0

  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i])
    const accountNumber = (fields[numberAt] ?? '').trim()
    if (!/^\d{3,}$/.test(accountNumber)) {
      malformed++
      continue
    }
    if (seen.has(accountNumber)) continue
    seen.add(accountNumber)

    const vatCode = vatAt === -1 ? '' : (fields[vatAt] ?? '').trim()
    accounts.push({
      accountNumber,
      accountName: (fields[nameAt] ?? '').trim(),
      vatCode: vatCode === '' ? null : vatCode,
      // An export without the column is treated as all-active rather than
      // all-inactive: hiding the whole chart is the worse failure.
      isActive: activeAt === -1 ? true : isTrue(fields[activeAt] ?? ''),
    })
  }

  if (malformed > 0) {
    warnings.push(`${malformed} rader hoppades över eftersom kontonumret saknades eller var ogiltigt.`)
  }
  if (accounts.length === 0) {
    warnings.push('Filen innehöll inga konton.')
  }

  return { accounts, warnings }
}
