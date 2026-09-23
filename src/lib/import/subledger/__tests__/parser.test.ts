import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSubledgerFile } from '../parser'
import { SUBLEDGER_COLUMNS, SubledgerImportSchema } from '../schema'

const values = ['001', '000123', '2026-08-31', '2026-09-20', 'SEK', '1250', '250', '625', 'B', '17', '2026', '00012345']
values.splice(5, 0, 'standard_25')
/** Encode a template row as CSV bytes for parser boundary tests. */
function csv(row = values) {
  return new TextEncoder().encode(SUBLEDGER_COLUMNS.join(';') + '\n' + row.join(';')).buffer
}
describe('subledger template parser', () => {
  it('preserves leading zeros and a partially paid balance', () => {
    expect(parseSubledgerFile(csv(), 'invoices.csv')[0]).toMatchObject({
      counterparty: '001', invoice_number: '000123', payment_reference: '00012345', remaining_amount: 625,
    })
  })
  it('accepts decimal commas without silently guessing thousands separators', () => {
    const row = [...values]; row[8] = '625,50'
    expect(parseSubledgerFile(csv(row), 'invoices.csv')[0].remaining_amount).toBe(625.5)
    row[8] = '1,234.50'
    expect(() => parseSubledgerFile(csv(row), 'invoices.csv')).toThrow('ROW_INVALID:2')
  })
  it.each([[4, 'EUR'], [6, '-1250'], [7, '1300'], [8, '1300'], [8, 'NaN'], [2, '2026-02-30']])(
    'rejects unsupported or inconsistent data at column %s', (column, value) => {
      const row = [...values]; row[Number(column)] = String(value)
      expect(() => parseSubledgerFile(csv(row), 'invoices.csv')).toThrow()
    },
  )
  it('reads XLSX text references and formatted numbers', () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...SUBLEDGER_COLUMNS], values]), 'Invoices')
    expect(parseSubledgerFile(XLSX.write(book, { type: 'array', bookType: 'xlsx' }), 'invoices.xlsx')[0].invoice_number).toBe('000123')
  })
  it('rejects multiple sheets rather than silently dropping invoices', () => {
    const book = XLSX.utils.book_new()
    for (const name of ['A', 'B']) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...SUBLEDGER_COLUMNS], values]), name)
    expect(() => parseSubledgerFile(XLSX.write(book, { type: 'array', bookType: 'xlsx' }), 'invoices.xlsx')).toThrow()
  })
  it('requires preview and a snapshot covering every invoice', () => {
    const input = { company_id: '00000000-0000-4000-8000-000000000001', kind: 'customer', snapshot_date: '2026-08-01', rows: parseSubledgerFile(csv(), 'a.csv'), execute: true }
    expect(SubledgerImportSchema.safeParse(input).success).toBe(false)
    expect(SubledgerImportSchema.safeParse({ ...input, execute: false, snapshot_date: '2026-09-21' }).success).toBe(true)
  })
})
