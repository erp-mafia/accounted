/**
 * Excel workbooks written part by part, the way an export service writes them,
 * and zipped the way a streaming writer zips: general purpose flag bit 3,
 * zeros in the local header and the CRC and sizes in a data descriptor after
 * the data. With the entries stored (no compression, the default here) SheetJS
 * 0.20.3 could not open such a zip ("Bad compressed size"), which is how
 * Handelsbanken's Excel export of account transactions failed in November
 * 2026; deflated entries it could.
 *
 * The parts are hand-written rather than produced by the xlsx package, so the
 * reader is tested against a writer other than itself: shared strings, numbers
 * with and without a number format, dates as Excel day numbers with a date
 * format, merged cells and styled empty rows. Synthetic rows only.
 */
import { deflateRawSync } from 'node:zlib'
import * as XLSX from 'xlsx'
import { crc32 } from '@/lib/reports/zip-writer'
import { escapeXml } from '@/lib/xml/escape'

/**
 * One cell. A date is the day number Excel stores, shown as yyyy-mm-dd or, with
 * format 'short', in Excel's default short date format.
 */
export type XlsxCell = string | number | { amount: number } | { date: string; format?: 'short' } | null

export interface XlsxSheet {
  rows: XlsxCell[][]
  /** Merged ranges as Excel writes them ("A1:E1"). */
  merges?: string[]
  /** Styled empty rows after the table: a writer that pads the sheet leaves them. */
  trailingEmptyRows?: number
}

// Cell styles (cellXfs): 0 General, 1 yyyy-mm-dd, 2 #,##0.00, 3 Excel's short date (m/d/yy).
const STYLE_ISO_DATE = 1
const STYLE_AMOUNT = 2
const STYLE_SHORT_DATE = 3

/** Excel's day number for a calendar date (the 1900 system). */
function excelDayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000
}

const columnName = XLSX.utils.encode_col

/** The parts of a one-sheet workbook, by path inside the zip. */
function xlsxParts(sheet: XlsxSheet): Record<string, string> {
  const strings: string[] = []
  const stringIndex = (text: string) => {
    const at = strings.indexOf(text)
    if (at >= 0) return at
    strings.push(text)
    return strings.length - 1
  }

  let lastColumn = 0
  const rowXml = sheet.rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (cell === null || cell === '') return ''
      lastColumn = Math.max(lastColumn, c)
      const ref = `${columnName(c)}${r + 1}`
      if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${stringIndex(cell)}</v></c>`
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
      if ('amount' in cell) return `<c r="${ref}" s="${STYLE_AMOUNT}"><v>${cell.amount}</v></c>`
      const style = cell.format === 'short' ? STYLE_SHORT_DATE : STYLE_ISO_DATE
      return `<c r="${ref}" s="${style}"><v>${excelDayNumber(cell.date)}</v></c>`
    })
    return `<row r="${r + 1}">${cells.join('')}</row>`
  })
  for (let i = 1; i <= (sheet.trailingEmptyRows ?? 0); i++) {
    const r = sheet.rows.length + i
    rowXml.push(`<row r="${r}"><c r="A${r}" s="${STYLE_AMOUNT}"/><c r="${columnName(lastColumn)}${r}" s="${STYLE_AMOUNT}"/></row>`)
  }
  const lastRow = sheet.rows.length + (sheet.trailingEmptyRows ?? 0)
  const merges = sheet.merges ?? []

  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const pkgRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

  return {
    '[Content_Types].xml':
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>` +
      `<Override PartName="/xl/sharedStrings.xml" ContentType="${ct}.sharedStrings+xml"/>` +
      '</Types>',
    '_rels/.rels':
      `${head}<Relationships xmlns="${pkgRelNs}">` +
      `<Relationship Id="rId1" Type="${relNs}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
    'xl/workbook.xml':
      `${head}<workbook xmlns="${ns}" xmlns:r="${relNs}"><sheets>` +
      '<sheet name="Transaktioner" sheetId="1" r:id="rId1"/>' +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      `${head}<Relationships xmlns="${pkgRelNs}">` +
      `<Relationship Id="rId1" Type="${relNs}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${relNs}/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId3" Type="${relNs}/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>',
    'xl/styles.xml':
      `${head}<styleSheet xmlns="${ns}">` +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs></styleSheet>',
    'xl/sharedStrings.xml':
      `${head}<sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('') +
      '</sst>',
    'xl/worksheets/sheet1.xml':
      `${head}<worksheet xmlns="${ns}" xmlns:r="${relNs}">` +
      `<dimension ref="A1:${columnName(lastColumn)}${lastRow}"/>` +
      `<sheetData>${rowXml.join('')}</sheetData>` +
      (merges.length > 0
        ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
        : '') +
      '</worksheet>',
  }
}

/** How a streaming writer's zip is shaped: the descriptor's optional signature, deflated or stored entries. */
export interface StreamedZipOptions {
  descriptorSignature?: boolean
  deflate?: boolean
}

/**
 * The files as a streamed zip: flag bit 3, sizes and CRC in a data descriptor
 * after each entry's data (with its optional signature, or without), and the
 * real values only in the central directory. Entries are stored, the shape the
 * reader failed on, unless `deflate` asks for the common compressed one.
 */
function streamedZip(files: Record<string, string>, options: StreamedZipOptions = {}): ArrayBuffer {
  const signature = options.descriptorSignature ?? true
  const method = options.deflate ? 8 : 0
  const encoder = new TextEncoder()
  const entries = Object.entries(files)
  const body: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0

  for (const [name, text] of entries) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(text)
    const written = options.deflate ? new Uint8Array(deflateRawSync(data)) : data
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0008, true) // bit 3: CRC and sizes follow the data
    local.setUint16(8, method, true)
    local.setUint16(26, nameBytes.length, true) // CRC and sizes stay 0

    const descriptor = new DataView(new ArrayBuffer(signature ? 16 : 12))
    const at = signature ? 4 : 0
    if (signature) descriptor.setUint32(0, 0x08074b50, true)
    descriptor.setUint32(at, crc, true)
    descriptor.setUint32(at + 4, written.length, true)
    descriptor.setUint32(at + 8, data.length, true)

    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true) // version made by
    central.setUint16(6, 20, true) // version needed
    central.setUint16(8, 0x0008, true)
    central.setUint16(10, method, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, written.length, true)
    central.setUint32(24, data.length, true)
    central.setUint16(28, nameBytes.length, true)
    central.setUint32(42, offset, true)

    body.push(new Uint8Array(local.buffer), nameBytes, written, new Uint8Array(descriptor.buffer))
    directory.push(new Uint8Array(central.buffer), nameBytes)
    offset += 30 + nameBytes.length + written.length + descriptor.byteLength
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, directorySize, true)
  end.setUint32(16, offset, true)

  const parts = [...body, ...directory, new Uint8Array(end.buffer)]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let pos = 0
  for (const part of parts) {
    out.set(part, pos)
    pos += part.length
  }
  return out.buffer
}

/** A one-sheet workbook as a streamed zip. */
export function streamedXlsx(sheet: XlsxSheet, options?: StreamedZipOptions): ArrayBuffer {
  return streamedZip(xlsxParts(sheet), options)
}

/**
 * Handelsbanken's Excel export of account transactions: a title and the
 * account above the column header (Reskontradatum, Transaktionsdatum, Text,
 * Belopp, Saldo), booking dates as date cells, amounts and balances as
 * numbers. The header and columns follow the bank's CSV download and the
 * open-source handelsbanken-xlsx reader in gigurra/subscription-detector
 * (2026); the real customer files were not available.
 */
export const HANDELSBANKEN_XLSX_ROWS: XlsxCell[][] = [
  ['Kontotransaktioner'],
  ['Kontonummer', '6789 123 456 789'],
  ['Period', '2026-11-01 - 2026-11-16'],
  [],
  ['Reskontradatum', 'Transaktionsdatum', 'Text', 'Belopp', 'Saldo'],
  [{ date: '2026-11-16' }, { date: '2026-11-14' }, 'KORTKÖP CLAS OHLSON', { amount: -199.5 }, { amount: 10234.75 }],
  [{ date: '2026-11-13' }, { date: '2026-11-13' }, 'Prel KORTKÖP ICA NÄRA', { amount: -89 }, { amount: 10434.25 }],
  [{ date: '2026-11-12' }, { date: '2026-11-12' }, 'INSÄTTNING KUND AB', { amount: 12500 }, { amount: 10434.25 }],
  [{ date: '2026-11-03' }, { date: '2026-11-02' }, 'BG LEVERANTÖR AB', { amount: -2065.75 }, { amount: -2065.75 }],
]
