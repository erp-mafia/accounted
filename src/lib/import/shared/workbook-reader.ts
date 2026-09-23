import * as XLSX from 'xlsx'
import { decodeFileContent } from './encoding'

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
 * a string before handing it to xlsx as `type: 'string'`.
 */
export function readWorkbookFromBuffer(buffer: ArrayBuffer, filename: string): XLSX.WorkBook {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'csv') {
    const content = decodeFileContent(buffer)
    return XLSX.read(content, { type: 'string' })
  }
  return XLSX.read(buffer, { type: 'array' })
}

/**
 * Read the workbook from `buffer` and return raw rows from its largest sheet.
 *
 * Picks the sheet with the most rows (a heuristic that handles files where
 * the header sheet isn't the first one). Returns rows as a 2D string array
 * with the header row included; cells default to empty string.
 */
export function readBestSheet(
  buffer: ArrayBuffer,
  filename: string,
): { sheetName: string; rawData: string[][] } {
  const workbook = readWorkbookFromBuffer(buffer, filename)

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

  const sheet = workbook.Sheets[bestSheet]
  const rawData: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  })

  return { sheetName: bestSheet, rawData }
}
