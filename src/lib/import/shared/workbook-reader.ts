import type { ParsingOptions, WorkBook } from 'xlsx'
import { decodeFileContent } from './encoding'

/** What a caller may tune on the read; the input type stays the reader's. */
export type WorkbookReadOptions = Pick<ParsingOptions, 'cellNF' | 'raw'>

/**
 * True when the bytes are markup (an HTML table or SpreadsheetML) rather than
 * a binary workbook. Many banks call an HTML table saved as .xls an "Excel
 * export".
 */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  while (i < bytes.length && i < 512 && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i])) i++
  return bytes[i] === 0x3c // '<'
}

/**
 * Read a workbook from a raw file buffer, with correct encoding handling
 * for CSV files.
 *
 * For binary spreadsheet formats (.xlsx, .xls, .ods), xlsx handles encoding
 * via the embedded codepage and we pass the buffer through as `type: 'array'`.
 *
 * For CSV files, xlsx with `type: 'array'` decodes bytes as Latin-1, which
 * mangles UTF-8 multi-byte sequences (e.g. Ö → Ã–). We instead detect the
 * source encoding (UTF-8 with optional BOM, or Windows-1252) and decode to
 * a string before handing it to xlsx as `type: 'string'`. Markup (an HTML
 * table named .xls) gets the same decode: read as an array, its
 * Windows-1252 bytes come out garbled.
 *
 * xlsx is imported here, when a file is read, not at module load.
 */
export async function readWorkbookFromBuffer(
  buffer: ArrayBuffer,
  filename: string,
  options: WorkbookReadOptions = {},
): Promise<WorkBook> {
  const XLSX = await import('xlsx')
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv' || looksLikeMarkup(new Uint8Array(buffer))) {
    const content = decodeFileContent(buffer)
    return XLSX.read(content, { ...options, type: 'string' })
  }
  return XLSX.read(buffer, { ...options, type: 'array' })
}

/**
 * Read the workbook from `buffer` and return raw rows from its largest sheet.
 *
 * Picks the sheet with the most rows (a heuristic that handles files where
 * the header sheet isn't the first one). Returns rows as a 2D string array
 * with the header row included; cells default to empty string.
 */
export async function readBestSheet(
  buffer: ArrayBuffer,
  filename: string,
): Promise<{ sheetName: string; rawData: string[][] }> {
  const XLSX = await import('xlsx')
  const workbook = await readWorkbookFromBuffer(buffer, filename)
  const bestSheet = largestSheet(XLSX, workbook)

  const sheet = workbook.Sheets[bestSheet]
  const rawData: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  })

  return { sheetName: bestSheet, rawData }
}

/**
 * readBestSheet's sheet with each cell's value instead of its formatted
 * text: a number stays a number and a date stays its serial. The formatted
 * text of a cell formatted `#,##0` is "12,000" whatever the user's locale,
 * which a Swedish amount reader takes for 12,00. A CSV is still read as the
 * text the file holds (no value guessing), so every CSV cell is a string.
 */
export async function readBestSheetValues(
  buffer: ArrayBuffer,
  filename: string,
): Promise<{ sheetName: string; rows: (string | number)[][] }> {
  const XLSX = await import('xlsx')
  const workbook = await readWorkbookFromBuffer(buffer, filename, { raw: true })
  const bestSheet = largestSheet(XLSX, workbook)
  const rows: (string | number)[][] = XLSX.utils.sheet_to_json(workbook.Sheets[bestSheet], {
    header: 1,
    defval: '',
    raw: true,
  })
  return { sheetName: bestSheet, rows }
}

/** The sheet with the most rows: the header sheet is not always the first one. */
function largestSheet(XLSX: typeof import('xlsx'), workbook: WorkBook): string {
  let bestSheet = workbook.SheetNames[0]
  let bestRowCount = 0
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
    const rowCount = range.e.r - range.s.r + 1
    if (rowCount > bestRowCount) {
      bestRowCount = rowCount
      bestSheet = name
    }
  }
  return bestSheet
}
