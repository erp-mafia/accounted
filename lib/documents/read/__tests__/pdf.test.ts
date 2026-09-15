import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { readPdfTextLayer, extractSinglePagePdf } from '../pdf'

// Real pdf-inspector on a PDF generated in the test: no fixtures, no network.
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
    // pdf-inspector positions text runs (a printed line), not single words.
    const words = out.pages[0].words ?? []
    expect(words.length).toBeGreaterThanOrEqual(2)
    const w = words.find((x) => x.t.includes('Hyresavtal'))!
    expect(w.y0).toBeGreaterThan(0)
    expect(w.y0).toBeLessThan(120) // near the top of the page in a top-left frame
    expect(w.x1).toBeGreaterThan(w.x0)
    expect(out.pages[0].pageHeight).toBe(842)
  })

  it('cuts one page out as its own PDF', async () => {
    const pdf = await makePdf([['forsta'], ['andra'], ['tredje']])
    const single = await extractSinglePagePdf(pdf, 2)
    const out = await readPdfTextLayer(single)
    expect(out.pageCount).toBe(1)
    expect(out.pages[0].text).toContain('andra')
  })
})
