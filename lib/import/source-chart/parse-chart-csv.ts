import { isAccountNumber } from '@/lib/invariants/account-number'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import {
  SOURCE_CHART_FORMATS,
  supportedFormatLabels,
  type SourceChartFormat,
} from './formats'

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
  /**
   * The format the header was recognised as, or null when none matched. Worth
   * surfacing: detection that guesses wrong in silence is worse than asking,
   * and naming what was read is what makes a wrong guess visible.
   */
  format: SourceChartFormat | null
  /**
   * What the parse noticed, in the import-wide notice shape (severity + i18n
   * code under `import_notices.*`), never thrown: a partial file still helps.
   * `action` is something the user must act on, `notice` is worth knowing.
   */
  notices: ImportNotice[]
}

/**
 * The first format whose required columns are all present in the header when
 * split on that format's delimiter. Column sets are fingerprints, so the first
 * match is the only match in practice.
 */
function detectFormat(text: string): { format: SourceChartFormat; header: string[]; rows: string[][] } | null {
  for (const format of SOURCE_CHART_FORMATS) {
    const records = splitCsvRecords(text, format.delimiter)
    if (records.length === 0) continue
    const header = records[0].map((h) => h.trim())
    const { accountNumber, accountName } = format.columns
    if (header.includes(accountNumber) && header.includes(accountName)) {
      return { format, header, rows: records.slice(1) }
    }
  }
  return null
}

/**
 * Split the whole file into records, honouring double-quoted fields.
 *
 * Deliberately small rather than a dependency: the only quoting this format
 * uses is a field wrapped in double quotes, with a doubled quote for a literal
 * one. Account names carrying a semicolon are the case that makes a plain
 * split wrong.
 *
 * Records, not lines. Splitting the text on newlines first and parsing quotes
 * afterwards honours a quoted delimiter but not a quoted line break, which is
 * half a guarantee: the same field that may hold a semicolon may hold a CR or
 * LF, and a parser that handles one and silently tears the other apart is
 * harder to diagnose than one that handles neither. CR, LF and CRLF all end a
 * record outside quotes and are all kept verbatim inside them.
 */
function splitCsvRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let fields: string[] = []
  let field = ''
  let inQuotes = false

  const endField = () => { fields.push(field); field = '' }
  const endRecord = () => {
    endField()
    // A trailing newline must not manufacture an empty record, and neither
    // must a blank line between rows.
    if (fields.some((f) => f.trim() !== '')) records.push(fields)
    fields = []
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char !== '"') {
        field += char
      } else if (text[i + 1] === '"') {
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
    if (char === delimiter) {
      endField()
      continue
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      endRecord()
      continue
    }
    field += char
  }
  if (field !== '' || fields.length > 0) endRecord()
  return records
}

/** True for the spellings Spiris writes into a boolean column. */
function isTrue(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'ja'
}

export function parseSourceChartCsv(content: string): ParsedSourceChart {
  const notices: ImportNotice[] = []
  // Strip the BOM before anything reads the first header, or the first column
  // is named "﻿IsActive" and never matches.
  const text = content.replace(/^﻿/, '')
  if (text.trim() === '') {
    return {
      accounts: [],
      format: null,
      notices: [makeNotice('source_chart_empty_file', 'action')],
    }
  }

  const detected = detectFormat(text)
  if (!detected) {
    // Name what is supported, not what the file lacks. A file that fails here
    // is far more likely to be a correct chart from a system this does not
    // read yet than a broken one, and telling its owner that AccountNumber is
    // missing sends them looking for a fault that is not there.
    notices.push(
      makeNotice('source_chart_unrecognised', 'action', {
        formats: supportedFormatLabels().join(', '),
      }),
    )
    return { accounts: [], format: null, notices }
  }

  const { format, header, rows } = detected
  const columnOf = (name: string | undefined) => (name === undefined ? -1 : header.indexOf(name))

  const numberAt = columnOf(format.columns.accountNumber)
  const nameAt = columnOf(format.columns.accountName)
  const vatAt = columnOf(format.columns.vatCode)
  const activeAt = columnOf(format.columns.isActive)

  if (vatAt === -1) {
    notices.push(
      makeNotice('source_chart_no_vat_column', 'action', { format: format.label }),
    )
  }

  const accounts: SourceChartAccount[] = []
  const seen = new Set<string>()
  let malformed = 0

  for (const fields of rows) {
    const accountNumber = (fields[numberAt] ?? '').trim()
    // The shared BAS rule, not a local regex: lib/invariants/account-number.ts
    // exists because this one was written out at twenty sites. A chart row that
    // is not four digits is a group heading or a broken row, never an account.
    if (!isAccountNumber(accountNumber)) {
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

  // A skipped row is worth knowing but costs nothing: it folds away behind
  // "Visa N anmärkningar" rather than taking the one ochre sentence.
  if (malformed > 0) {
    notices.push(makeNotice('source_chart_rows_skipped', 'notice', { count: malformed }))
  }
  if (accounts.length === 0) {
    notices.push(makeNotice('source_chart_no_accounts', 'action'))
  }

  return { accounts, format, notices }
}
