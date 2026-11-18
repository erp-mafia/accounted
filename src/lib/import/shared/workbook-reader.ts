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
 * The reader could not open the file: a broken or unsupported workbook, which
 * is the file's problem, not a server fault. `cause` is the reader's own
 * error. The message carries the reader's reason with every number masked
 * ("Bad compressed size: # != #"): the log keeps only name and message, and
 * its redaction blanks a whole message that holds a ten-digit run. Letters
 * outside ASCII are masked too: a reason that names a sheet ("Försäljning")
 * would pass getErrorMessage's test for a sentence written for the user.
 *
 * `code` is the registry answer (400, "save it again as .xlsx or CSV") that
 * classifyError and getErrorMessage read off a thrown error, so a door that
 * hands the error to errorResponse, and the browser that reads the file
 * itself, say the same thing. The bank file doors answer their own
 * BANK_FILE_WORKBOOK_UNREADABLE, whose way forward names the bank's export.
 */
export class UnreadableWorkbookError extends Error {
  readonly code = 'IMPORT_WORKBOOK_UNREADABLE'

  constructor(cause: unknown) {
    const reason = (cause instanceof Error ? cause.message : String(cause))
      .replace(/\d+/g, '#')
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, 80)
    super(`The workbook could not be read: ${reason}`, { cause })
    this.name = 'UnreadableWorkbookError'
  }
}

const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_CENTRAL_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
/** General purpose flag bit 3: CRC and sizes follow the data, in a data descriptor. */
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
/** A size too large for 32 bits; the real one sits in a ZIP64 field. */
const ZIP64_SIZE = 0xffffffff

/** Offset of the end of central directory record, or -1. */
function endOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - 22
  const first = Math.max(0, last - 0xffff) // the record ends with a comment of at most 64 KiB
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) === ZIP_END_OF_CENTRAL_DIRECTORY) return at
  }
  return -1
}

/**
 * A zip whose local headers say what its central directory says.
 *
 * A streaming zip writer does not know an entry's size until it has written
 * the entry, so it sets flag bit 3, leaves zeros in the local header and puts
 * the CRC and sizes in a data descriptor after the data. The xlsx reader
 * (SheetJS 0.20.3) takes an entry's size from its local header, so for a
 * stored (uncompressed) entry it reads the descriptor out of the entry's own
 * bytes and throws "Bad compressed size". Handelsbanken's Excel export of
 * account transactions failed so in November 2026. The central directory at
 * the end of every zip holds each entry's real CRC and sizes; they are copied
 * into the local headers, in a copy of the bytes, and bit 3 is cleared. A file
 * that is not a zip, or a zip this cannot follow (every read is bounds-checked),
 * is returned as it came, for the reader to open or refuse.
 */
export function withCentralDirectorySizes(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer)
  if (view.byteLength < 30 || view.getUint32(0, true) !== ZIP_LOCAL_HEADER) return buffer
  const end = endOfCentralDirectory(view)
  if (end < 0) return buffer

  const entries = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  let aligned: DataView<ArrayBuffer> | null = null
  for (let i = 0; i < entries; i++) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== ZIP_CENTRAL_HEADER) return buffer
    const crc = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const local = view.getUint32(at + 42, true)
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)

    if (local + 30 > view.byteLength || view.getUint32(local, true) !== ZIP_LOCAL_HEADER) return buffer
    const flags = view.getUint16(local + 6, true)
    if ((flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0 || compressedSize === ZIP64_SIZE || size === ZIP64_SIZE) continue
    aligned ??= new DataView(buffer.slice(0))
    aligned.setUint16(local + 6, flags & ~ZIP_DATA_DESCRIPTOR_FLAG, true)
    aligned.setUint32(local + 14, crc, true)
    aligned.setUint32(local + 18, compressedSize, true)
    aligned.setUint32(local + 22, size, true)
  }
  return aligned ? aligned.buffer : buffer
}

/**
 * Read a workbook from a raw file buffer, with correct encoding handling
 * for CSV files.
 *
 * For binary spreadsheet formats (.xlsx, .xls, .ods), xlsx handles encoding
 * via the embedded codepage and we pass the buffer through as `type: 'array'`,
 * a zipped workbook with its local headers aligned first
 * (withCentralDirectorySizes).
 *
 * For CSV files, xlsx with `type: 'array'` decodes bytes as Latin-1, which
 * mangles UTF-8 multi-byte sequences (e.g. Ö → Ã–). We instead detect the
 * source encoding (UTF-8 with optional BOM, or Windows-1252) and decode to
 * a string before handing it to xlsx as `type: 'string'`. Markup (an HTML
 * table named .xls) gets the same decode: read as an array, its
 * Windows-1252 bytes come out garbled.
 *
 * A file the reader cannot open throws UnreadableWorkbookError, as does a
 * workbook with a sheet it could not parse: the reader keeps that sheet's
 * name and leaves the sheet itself out, which every caller would trip on.
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
  const text = ext === 'csv' || looksLikeMarkup(new Uint8Array(buffer))
  const input = text ? decodeFileContent(buffer) : withCentralDirectorySizes(buffer)
  let workbook: WorkBook
  try {
    workbook = XLSX.read(input, { ...options, type: text ? 'string' : 'array' })
  } catch (err) {
    throw new UnreadableWorkbookError(err)
  }
  if (workbook.SheetNames.some((name) => !workbook.Sheets[name])) {
    throw new UnreadableWorkbookError(new Error('a sheet could not be parsed'))
  }
  return workbook
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
