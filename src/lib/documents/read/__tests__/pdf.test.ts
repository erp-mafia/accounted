import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { readPdfTextLayer, extractSinglePagePdf } from '../pdf'

// The real reader (pdf.js through unpdf) on a PDF generated in the test: no fixtures, no network.
async function makePdf(lines: string[][]): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const pageLines of lines) {
    const page = doc.addPage([595, 842])
    pageLines.forEach((line, i) => page.drawText(line, { x: 72, y: 780 - i * 24, size: 12, font }))
  }
  return Buffer.from(await doc.save())
}

describe('readPdfTextLayer', () => {
  it('reads a text-based PDF page by page with word boxes in a top-left frame', async () => {
    const pdf = await makePdf([['Hyresavtal Vasagatan 12', 'Hyran ar 19 300 kr per manad'], ['Uppsagningstid nio manader']])
    const out = await readPdfTextLayer(pdf)
    expect(out.pageCount).toBe(2)
    expect(out.pagesNeedingVision).toEqual([])
    expect(out.pages.map((p) => p.pageNo)).toEqual([1, 2])
    expect(out.pages[0].text).toContain('19 300')
    expect(out.pages[1].text).toContain('Uppsagningstid')
    // pdf.js positions text runs (a printed line), not single words.
    const words = out.pages[0].words ?? []
    expect(words.length).toBeGreaterThanOrEqual(2)
    const w = words.find((x) => x.t.includes('Hyresavtal'))!
    expect(w.y0).toBeGreaterThan(0)
    expect(w.y0).toBeLessThan(120) // near the top of the page in a top-left frame
    expect(w.x1).toBeGreaterThan(w.x0)
    expect(out.pages[0].pageHeight).toBe(842)
  })

  it('sends a page without a text layer to the model and keeps the text pages', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage([595, 842]).drawText('Bilaga 1: inskannad sida följer', { x: 72, y: 780, size: 12, font })
    doc.addPage([595, 842]) // a scan: nothing but (in real life) an image
    doc.addPage([595, 842]).drawText('3', { x: 290, y: 30, size: 10, font }) // a scan with a stamped page number
    const out = await readPdfTextLayer(Buffer.from(await doc.save()))
    expect(out.pageCount).toBe(3)
    expect(out.pages.map((p) => p.pageNo)).toEqual([1])
    expect(out.pagesNeedingVision).toEqual([2, 3])
  })

  // pdf.js walks a page's drawing operations with ArrayBuffer.transferToFixedLength (Node 21+). Production runs Node 24;
  // CI's Node 20 cannot, and there pdf.js skips the walk, so no page is flagged and every page keeps its text.
  const canWalkOperators = typeof (ArrayBuffer.prototype as { transferToFixedLength?: unknown }).transferToFixedLength === 'function'
  it.skipIf(!canWalkOperators)('marks a text page that is mostly a picture for the model, and leaves a text page with a logo alone', async () => {
    // A 1x1 PNG: enough to put a paint-image operation on the page.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const image = await doc.embedPng(png)
    const table = doc.addPage([595, 842])
    table.drawText('Schedule 1.2 - Cap Table', { x: 72, y: 780, size: 12, font })
    table.drawImage(image, { x: 72, y: 300, width: 450, height: 400 })
    const prose = doc.addPage([595, 842])
    prose.drawImage(image, { x: 72, y: 790, width: 20, height: 20 })
    Array.from({ length: 20 }, (_, i) => prose.drawText(`Clause ${i + 1}: the parties agree that the shares shall be held as set out below.`, { x: 72, y: 760 - i * 20, size: 10, font }))
    const out = await readPdfTextLayer(Buffer.from(await doc.save()))
    expect(out.pagesNeedingVision).toEqual([])
    expect(out.pagesWithImages).toEqual([1])
    // Both pages keep their text layer until the model has read the picture page.
    expect(out.pages.map((p) => p.pageNo)).toEqual([1, 2])
  })

  it('leaves the caller its bytes (pdf.js takes ownership of what it is given)', async () => {
    const pdf = await makePdf([['Avtal']])
    const before = pdf.length
    await readPdfTextLayer(pdf)
    expect(pdf.length).toBe(before)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('cuts one page out as its own PDF', async () => {
    const pdf = await makePdf([['forsta sidan i avtalet'], ['andra sidan i avtalet'], ['tredje sidan i avtalet']])
    const single = await extractSinglePagePdf(pdf, 2)
    const out = await readPdfTextLayer(single)
    expect(out.pageCount).toBe(1)
    expect(out.pages[0].text).toContain('andra')
  })
})
