/**
 * Excel workbooks as bank files (.xls / .xlsx).
 *
 * Some banks hand out account history only as a spreadsheet: Länsförsäkringar's
 * kontoutdrag is one .xls file per month (crm#1236). Every bank parser reads
 * text, so a workbook is turned into semicolon-separated text once, here, and
 * from then on travels the CSV path unchanged: format detection, the parsers,
 * the file hash and the manual column mapping all see the same text.
 *
 * Cells are written in the shape a Swedish bank CSV uses: dates as YYYY-MM-DD
 * from the cell's date value (never the spreadsheet's display text, which the
 * reader renders in US order, "10/3/25"), numbers with a decimal comma and no
 * grouping, text as is.
 */

import type { CellObject, WorkSheet } from 'xlsx'
import { decodeFileContent } from '../shared/encoding'
import { looksLikeMarkup, readWorkbookFromBuffer } from '../shared/workbook-reader'

/** File extensions the bank file upload treats as workbooks. */
export const WORKBOOK_EXTENSIONS = ['.xls', '.xlsx'] as const

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)
}

function extensionOf(filename: string): string {
  const name = filename.toLowerCase()
  return name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
}

/**
 * True when the file is read as a workbook: binary Excel content (OLE2 .xls,
 * zipped .xlsx) whatever its name, or an HTML table named .xls/.xlsx. A plain
 * text file named .xls stays text: the text decode reads its encoding right,
 * where the workbook reader would read the bytes as Latin-1.
 */
export function isWorkbookFile(buffer: ArrayBuffer, filename: string): boolean {
  const bytes = new Uint8Array(buffer)
  if (startsWith(bytes, OLE2_MAGIC) || startsWith(bytes, ZIP_MAGIC)) return true
  return (WORKBOOK_EXTENSIONS as readonly string[]).includes(extensionOf(filename)) && looksLikeMarkup(bytes)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** A number as a Swedish bank CSV writes it: decimal comma, no grouping. */
function numberText(value: number): string {
  if (!Number.isFinite(value)) return ''
  return String(value).replace('.', ',')
}

type Xlsx = typeof import('xlsx')

function cellText(XLSX: Xlsx, cell: CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return ''
  switch (cell.t) {
    case 'n': {
      const value = cell.v as number
      if (cell.z !== undefined && XLSX.SSF.is_date(cell.z)) {
        const parts = XLSX.SSF.parse_date_code(value)
        if (parts && parts.y > 0) return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`
      }
      return numberText(value)
    }
    case 'd': {
      const date = cell.v as Date
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
    }
    case 'b':
      return cell.v ? 'TRUE' : 'FALSE'
    case 'e':
      return ''
    default:
      return String(cell.v)
  }
}

/** One CSV cell: one line per row, so line breaks inside a cell become spaces. */
function csvCell(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, ' ').trim()
  return /[;"]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat
}

function sheetRows(XLSX: Xlsx, sheet: WorkSheet): string[][] {
  if (!sheet['!ref']) return []
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const rows: string[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      row.push(cellText(XLSX, sheet[XLSX.utils.encode_cell({ r, c })] as CellObject | undefined))
    }
    while (row.length > 0 && row[row.length - 1].trim() === '') row.pop()
    if (row.length > 0) rows.push(row)
  }
  return rows
}

/**
 * The workbook's sheet with the most non-empty rows, as semicolon-separated
 * text. A bank export has one sheet; the heuristic only matters for a file the
 * customer re-saved with an extra one.
 */
export async function workbookToText(buffer: ArrayBuffer, filename: string): Promise<string> {
  const XLSX = await import('xlsx')
  // cellNF keeps each cell's number format, the only thing that tells a date
  // from a number in a binary workbook. raw keeps an HTML table's text as
  // text: parsing it would turn "2025-10-03" into a serial in the server's
  // time zone.
  const workbook = await readWorkbookFromBuffer(buffer, filename, { cellNF: true, raw: true })
  let best: string[][] = []
  for (const name of workbook.SheetNames) {
    const rows = sheetRows(XLSX, workbook.Sheets[name])
    if (rows.length > best.length) best = rows
  }
  return best.map((row) => row.map(csvCell).join(';')).join('\n')
}

/**
 * The text every bank parser reads: a workbook converted by workbookToText,
 * anything else decoded as a text file (UTF-8 / UTF-16 / Windows-1252).
 */
export async function decodeBankFile(
  buffer: ArrayBuffer,
  filename: string,
): Promise<{ content: string; workbook: boolean }> {
  if (isWorkbookFile(buffer, filename)) {
    return { content: await workbookToText(buffer, filename), workbook: true }
  }
  return { content: decodeFileContent(buffer), workbook: false }
}
