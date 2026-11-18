import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { streamedXlsx } from '@/tests/fixtures/streamed-xlsx'
import { classifyError } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  readBestSheet,
  readBestSheetValues,
  readWorkbookFromBuffer,
  UnreadableWorkbookError,
  withCentralDirectorySizes,
} from '../workbook-reader'

function bufFromBytes(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

function rowsOf(workbook: XLSX.WorkBook): string[][] {
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as string[][]
}

describe('readWorkbookFromBuffer', () => {
  it('decodes UTF-8 CSV with Swedish characters correctly', async () => {
    const csv = new TextEncoder().encode('Namn,Ort\nAcme,GÖTEBORG\nBeta,KÄRRA\n').buffer
    const wb = await readWorkbookFromBuffer(csv, 'lev.csv')
    expect(rowsOf(wb)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
      ['Beta', 'KÄRRA'],
    ])
  })

  it('decodes UTF-8 CSV with BOM', async () => {
    const bom = [0xef, 0xbb, 0xbf]
    const body = Array.from(new TextEncoder().encode('Namn,Ort\nAcme,GÖTEBORG\n'))
    const wb = await readWorkbookFromBuffer(bufFromBytes([...bom, ...body]), 'lev.csv')
    expect(rowsOf(wb)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
  })

  it('decodes Windows-1252 CSV with Swedish characters', async () => {
    // "Namn,Ort\nAcme,GÖTEBORG\nBeta,KÄRRA\n" in Windows-1252:
    // Ö = 0xD6, Ä = 0xC4
    const bytes = [
      0x4e, 0x61, 0x6d, 0x6e, 0x2c, 0x4f, 0x72, 0x74, 0x0a,
      0x41, 0x63, 0x6d, 0x65, 0x2c, 0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47, 0x0a,
      0x42, 0x65, 0x74, 0x61, 0x2c, 0x4b, 0xc4, 0x52, 0x52, 0x41, 0x0a,
    ]
    const wb = await readWorkbookFromBuffer(bufFromBytes(bytes), 'lev.csv')
    expect(rowsOf(wb)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
      ['Beta', 'KÄRRA'],
    ])
  })

  it('reads xlsx files via the binary path', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    const result = await readWorkbookFromBuffer(buffer, 'data.xlsx')
    expect(rowsOf(result)).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
  })

  it('treats non-csv extensions as binary spreadsheets', async () => {
    // .xls and .ods both go through the binary path; xlsx handles encoding internally
    const ws = XLSX.utils.aoa_to_sheet([['A'], ['Ö']])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    const result = await readWorkbookFromBuffer(buffer, 'data.xls')
    expect(rowsOf(result)).toEqual([['A'], ['Ö']])
  })
})

// A streaming zip writer leaves an entry's sizes for a data descriptor after
// the data; the xlsx reader trusted the zeros in the local header. Every
// importer that reads a workbook goes through readWorkbookFromBuffer.
describe('a workbook from a streaming zip writer', () => {
  const rows = [['Kundnummer', 'Namn'], ['1001', 'Kund AB']]

  it.each([{ deflate: false }, { deflate: true }])('reads for every importer (readBestSheet, %o)', async (shape) => {
    const { rawData } = await readBestSheet(streamedXlsx({ rows }, shape), 'kunder.xlsx')
    expect(rawData).toEqual(rows)
  })

  it('leaves a zip that has its sizes in the local headers as it came', () => {
    const regular = XLSX.write(XLSX.utils.book_new(XLSX.utils.aoa_to_sheet(rows)), { bookType: 'xlsx', type: 'array' })
    expect(withCentralDirectorySizes(regular)).toBe(regular)
  })

  it('throws UnreadableWorkbookError for a file it cannot open, naming the reason without its numbers', async () => {
    const cut = new Uint8Array(streamedXlsx({ rows })).slice(0, 600).buffer
    const thrown = await readWorkbookFromBuffer(cut, 'kunder.xlsx').catch((err: unknown) => err)
    expect(thrown).toBeInstanceOf(UnreadableWorkbookError)
    expect((thrown as Error).cause).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/^The workbook could not be read: \S/)
  })

  it('masks the numbers in the reason, which the log redaction would blank whole', () => {
    const err = new UnreadableWorkbookError(new Error('Bad compressed size: 816 != 1702240364'))
    expect(err.message).toBe('The workbook could not be read: Bad compressed size: # != #')
  })

  it('masks letters outside ASCII in the reason, which would pass for a sentence written for the user', () => {
    const err = new UnreadableWorkbookError(new Error('Cannot find file xl/worksheets/Försäljning.xml in zip'))
    expect(err.message).toBe('The workbook could not be read: Cannot find file xl/worksheets/F?rs?ljning.xml in zip')
    expect(getErrorMessage(err)).toContain('Filen kunde inte läsas.')
  })

  // The xlsx reader swallows a sheet's own parse error: the sheet's name
  // stays in SheetNames and the sheet is left out. Every caller reads
  // Sheets[name], so the workbook is refused whole, whichever sheet it was.
  it.each(['/xl/worksheets/sheet1.xml', '/xl/worksheets/sheet2.xml'])(
    'throws UnreadableWorkbookError for a workbook whose sheet part %s is missing',
    async (part) => {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Kunder')
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Info']]), 'Info')
      const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), { type: 'array' })
      XLSX.CFB.utils.cfb_del(zip, part)
      const bytes = new Uint8Array(XLSX.CFB.write(zip, { type: 'array', fileType: 'zip' }) as ArrayBuffer)
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

      await expect(readBestSheet(buffer, 'kunder.xlsx')).rejects.toBeInstanceOf(UnreadableWorkbookError)
      await expect(readBestSheetValues(buffer, 'budget.xlsx')).rejects.toBeInstanceOf(UnreadableWorkbookError)
    },
  )

  // The error names its own registry answer: a door that hands it to
  // errorResponse answers 400, and the browser that read the file itself
  // (the article import) shows the same sentence, never the reader's English.
  it('is a refusal with the way forward wherever it is caught', () => {
    const err = new UnreadableWorkbookError(new Error('File is password-protected'))
    expect(classifyError(err)).toMatchObject({ code: 'IMPORT_WORKBOOK_UNREADABLE', transient: false })
    expect(getErrorMessage(err)).toBe(
      'Filen kunde inte läsas. Den kan vara skadad eller lösenordsskyddad. Öppna den i Excel, spara den utan lösenord som Excel-arbetsbok (.xlsx) eller som CSV och ladda upp den igen.',
    )
    expect(getErrorMessage(err, { locale: 'en' })).toContain('save it without a password as an Excel workbook (.xlsx) or as CSV')
  })
})
