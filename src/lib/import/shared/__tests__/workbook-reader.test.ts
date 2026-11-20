import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import * as XLSX from 'xlsx'
import { crc32 } from '@/lib/reports/zip-writer'
import { damagedXlsx } from '@/tests/fixtures/damaged-xlsx'
import { streamedXlsx } from '@/tests/fixtures/streamed-xlsx'
import { classifyError } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  assertZipEntriesInflate,
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

// The xlsx reader's own inflate runs on past a damaged entry's data and the
// file's end: a sheet with its first deflate bytes overwritten kept it busy for
// minutes (#246). Every deflated entry is inflated first, bounded by its
// declared size, and the workbook is refused unless each one inflates to its
// declared size and CRC-32.
describe('a workbook with damaged compressed data', () => {
  const rows = [['Kundnummer', 'Namn', 'Ort']]
  for (let i = 0; i < 400; i++) rows.push([String(1000 + i), `Kund ${i} AB`, i % 2 ? 'Göteborg' : 'Stockholm'])

  /** The workbook's parts by path inside the zip, as the xlsx package writes them. */
  function workbookParts(): Record<string, Uint8Array> {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Kunder')
    const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })), { type: 'array' })
    const parts: Record<string, Uint8Array> = {}
    ;(zip.FullPaths as string[]).forEach((path, i) => {
      const entry = zip.FileIndex[i] as { type: number; content: ArrayLike<number> }
      if (entry.type === 2 && !path.endsWith('Sh33tJ5')) parts[path.replace(/^Root Entry\//, '')] = Uint8Array.from(entry.content)
    })
    return parts
  }

  /**
   * A zip of `parts`, each deflated by node:zlib (a writer other than the
   * reader's), declaring the uncompressed size `declared` gives for a part.
   */
  function zipOf(parts: Record<string, Uint8Array>, declared: Record<string, number> = {}): ArrayBuffer {
    const encoder = new TextEncoder()
    const local: Uint8Array[] = []
    const central: Uint8Array[] = []
    let offset = 0
    for (const [name, content] of Object.entries(parts)) {
      const path = encoder.encode(name)
      const data = new Uint8Array(deflateRawSync(content))
      const crc = crc32(content)
      const size = declared[name] ?? content.length

      const header = new DataView(new ArrayBuffer(30))
      header.setUint32(0, 0x04034b50, true)
      header.setUint16(4, 20, true)
      header.setUint16(8, 8, true)
      header.setUint32(14, crc, true)
      header.setUint32(18, data.length, true)
      header.setUint32(22, size, true)
      header.setUint16(26, path.length, true)
      local.push(new Uint8Array(header.buffer), path, data)

      const entry = new DataView(new ArrayBuffer(46))
      entry.setUint32(0, 0x02014b50, true)
      entry.setUint16(4, 20, true)
      entry.setUint16(6, 20, true)
      entry.setUint16(10, 8, true)
      entry.setUint32(16, crc, true)
      entry.setUint32(20, data.length, true)
      entry.setUint32(24, size, true)
      entry.setUint16(28, path.length, true)
      entry.setUint32(42, offset, true)
      central.push(new Uint8Array(entry.buffer), path)
      offset += 30 + path.length + data.length
    }
    const directorySize = central.reduce((sum, chunk) => sum + chunk.length, 0)
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, Object.keys(parts).length, true)
    end.setUint16(10, Object.keys(parts).length, true)
    end.setUint32(12, directorySize, true)
    end.setUint32(16, offset, true)
    const chunks = [...local, ...central, new Uint8Array(end.buffer)]
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out.buffer
  }

  it.each([0x00, 0xff])('refuses a sheet whose first 16 deflate bytes are overwritten with %i, well inside 2 seconds', async (fill) => {
    const buffer = damagedXlsx(rows, fill)
    const started = performance.now()
    const thrown = await readBestSheet(buffer, 'kunder.xlsx').catch((err: unknown) => err)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(thrown).toBeInstanceOf(UnreadableWorkbookError)
    expect(classifyError(thrown)).toMatchObject({ code: 'IMPORT_WORKBOOK_UNREADABLE', transient: false })
    expect(getErrorMessage(thrown)).toContain('Filen kunde inte läsas.')
    await expect(readBestSheetValues(buffer, 'budget.xlsx')).rejects.toBeInstanceOf(UnreadableWorkbookError)
  }, 5000)

  it('reads a workbook the xlsx package deflated', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Kunder')
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer
    const { rawData } = await readBestSheet(buffer, 'kunder.xlsx')
    expect(rawData).toEqual(rows)
  })

  it('reads a workbook another writer deflated', async () => {
    const { rawData } = await readBestSheet(zipOf(workbookParts()), 'kunder.xlsx')
    expect(rawData).toEqual(rows)
  })

  it('refuses an entry that declares a small size and inflates large', async () => {
    const parts = workbookParts()
    const sheet = new TextDecoder().decode(parts['xl/worksheets/sheet1.xml'])
    expect(sheet).toContain('<sheetData>')
    // 16 MiB of whitespace inside the sheet, declared as the sheet's own size.
    parts['xl/worksheets/sheet1.xml'] = new TextEncoder().encode(sheet.replace('<sheetData>', `<sheetData>${' '.repeat(16 * 1024 * 1024)}`))
    const buffer = zipOf(parts, { 'xl/worksheets/sheet1.xml': sheet.length })
    expect(buffer.byteLength).toBeLessThan(256 * 1024)

    await expect(assertZipEntriesInflate(buffer)).rejects.toBeInstanceOf(UnreadableWorkbookError)
    await expect(readBestSheet(buffer, 'kunder.xlsx')).rejects.toBeInstanceOf(UnreadableWorkbookError)
  }, 10000)

  it('refuses an entry whose content does not match its declared checksum', async () => {
    const buffer = zipOf(workbookParts())
    const view = new DataView(buffer)
    view.setUint32(14, view.getUint32(14, true) ^ 1, true) // the first local header's CRC-32
    const end = buffer.byteLength - 22
    const directory = view.getUint32(end + 16, true)
    view.setUint32(directory + 16, view.getUint32(directory + 16, true) ^ 1, true)
    await expect(readBestSheet(buffer, 'kunder.xlsx')).rejects.toBeInstanceOf(UnreadableWorkbookError)
  })

  it('leaves bytes that are not a zip to the reader', async () => {
    await expect(assertZipEntriesInflate(new TextEncoder().encode('Namn;Ort\n').buffer)).resolves.toBeUndefined()
  })
})
