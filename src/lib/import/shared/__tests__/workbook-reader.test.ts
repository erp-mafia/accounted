import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readWorkbookFromBuffer } from '../workbook-reader'

function bufFromBytes(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

function rowsOf(workbook: XLSX.WorkBook): string[][] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as string[][]
}

describe('readWorkbookFromBuffer', () => {
  it('decodes UTF-8 CSV with Swedish characters correctly', () => {
    const csv = new TextEncoder().encode('Namn,Ort\nAcme,GÖTEBORG\nBeta,KÄRRA\n').buffer
    const wb = readWorkbookFromBuffer(csv, 'lev.csv')
    expect(rowsOf(wb)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
      ['Beta', 'KÄRRA'],
    ])
  })

  it('decodes UTF-8 CSV with BOM', () => {
    const bom = [0xef, 0xbb, 0xbf]
    const body = Array.from(new TextEncoder().encode('Namn,Ort\nAcme,GÖTEBORG\n'))
    const wb = readWorkbookFromBuffer(bufFromBytes([...bom, ...body]), 'lev.csv')
    expect(rowsOf(wb)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
  })

  it('decodes Windows-1252 CSV with Swedish characters', () => {
    // "Namn,Ort\nAcme,GÖTEBORG\nBeta,KÄRRA\n" in Windows-1252:
    // Ö = 0xD6, Ä = 0xC4
    const bytes = [
      0x4e, 0x61, 0x6d, 0x6e, 0x2c, 0x4f, 0x72, 0x74, 0x0a,
      0x41, 0x63, 0x6d, 0x65, 0x2c, 0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47, 0x0a,
      0x42, 0x65, 0x74, 0x61, 0x2c, 0x4b, 0xc4, 0x52, 0x52, 0x41, 0x0a,
    ]
    const wb = readWorkbookFromBuffer(bufFromBytes(bytes), 'lev.csv')
    expect(rowsOf(wb)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
      ['Beta', 'KÄRRA'],
    ])
  })

  it('reads xlsx files via the binary path', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    const result = readWorkbookFromBuffer(buffer, 'data.xlsx')
    expect(rowsOf(result)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
  })

  it('treats non-csv extensions as binary spreadsheets', () => {
    // .xls and .ods both go through the binary path; xlsx handles encoding internally
    const ws = XLSX.utils.aoa_to_sheet([['A'], ['Ö']])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    const result = readWorkbookFromBuffer(buffer, 'data.xls')
    expect(rowsOf(result)).toEqual([['A'], ['Ö']])
  })
})
