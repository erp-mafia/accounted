/**
 * A workbook zipped with deflate by the xlsx package, with the first 16 bytes
 * of sheet1's compressed data overwritten by `fill`. The xlsx reader's own
 * inflate ran on such a file for minutes (#246). Synthetic rows only.
 */
import * as XLSX from 'xlsx'

export function damagedXlsx(rows: string[][], fill = 0x00): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Blad1')
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const name = new TextEncoder().encode('xl/worksheets/sheet1.xml')
  for (let at = 0; at + 30 < bytes.length; at++) {
    if (view.getUint32(at, true) !== 0x04034b50) continue
    const nameLength = view.getUint16(at + 26, true)
    const found = bytes.subarray(at + 30, at + 30 + nameLength)
    if (found.length !== name.length || !found.every((b, i) => b === name[i])) continue
    if (view.getUint16(at + 8, true) !== 8) throw new Error('sheet1 is not deflated')
    const data = at + 30 + nameLength + view.getUint16(at + 28, true)
    bytes.fill(fill, data, data + 16)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
  throw new Error('sheet1 not found')
}
