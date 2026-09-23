import * as XLSX from 'xlsx'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { SUBLEDGER_COLUMNS, SubledgerRowSchema, type SubledgerRow } from './schema'

/** Parse template files without converting invoice/OCR identifiers to numbers. */
export function parseSubledgerFile(buffer: ArrayBuffer, filename: string): SubledgerRow[] {
  if (!/\.(csv|xlsx)$/i.test(filename) || buffer.byteLength > 10 * 1024 * 1024) {
    throw new Error('SUBLEDGER_FILE_INVALID')
  }
  // raw:true is essential for CSV: "00123" must not become "123".
  const workbook = /\.csv$/i.test(filename)
    ? XLSX.read(decodeFileContent(buffer), { type: 'string', raw: true })
    : XLSX.read(buffer, { type: 'array' })
  if (workbook.SheetNames.length !== 1) throw new Error('SUBLEDGER_FILE_INVALID')
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
  if (range.e.r > 501 || range.e.c > 30) throw new Error('SUBLEDGER_FILE_INVALID')
  const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' })
  const headers = (data.shift() ?? []).map(value => String(value).trim())
  if (headers.length !== SUBLEDGER_COLUMNS.length || new Set(headers).size !== headers.length
    || SUBLEDGER_COLUMNS.some(column => !headers.includes(column))) {
    throw new Error('SUBLEDGER_COLUMNS_INVALID')
  }
  const numeric = new Set(['total', 'vat_amount', 'remaining_amount', 'voucher_number', 'voucher_year'])
  const rows = data.filter(row => row.some(cell => String(cell).trim())).map((row, index) => {
    const values: Record<string, unknown> = {}
    for (const [columnIndex, header] of headers.entries()) {
      const value = String(row[columnIndex] ?? '').trim()
      if (numeric.has(header)) {
        // Accept Swedish decimal commas, but no ambiguous thousands separators.
        if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) throw new Error(`SUBLEDGER_ROW_INVALID:${index + 2}`)
        values[header] = Number(value.replace(',', '.'))
      } else values[header] = value
    }
    const parsed = SubledgerRowSchema.safeParse(values)
    if (!parsed.success) throw new Error(`SUBLEDGER_ROW_INVALID:${index + 2}`)
    return parsed.data
  })
  if (!rows.length || rows.length > 500) throw new Error('SUBLEDGER_FILE_INVALID')
  return rows
}
