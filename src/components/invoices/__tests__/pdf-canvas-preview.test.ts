import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Regression pin for crm#1689 / accounted#178: Safari never painted the
 * invoice PDF previews, an <object type="application/pdf"> with a blob: URL.
 * Where lib/browser/pdf-embed says so, both previews draw the PDF with the
 * pdf.js renderer instead; everywhere else they keep the <object>. The repo
 * does not render components in tests, so pin the source shape.
 */
const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8')
const CANVAS = read('../PdfCanvasPreview.tsx')
const PANE = read('../editor/EditorPreviewPane.tsx')
const CARD = read('../../settings/InvoicePreviewCard.tsx')

describe('PdfCanvasPreview', () => {
  it('draws with the pdf.js build the signing page uses, loaded on demand', () => {
    expect(CANVAS).toContain("import('unpdf/pdfjs')")
    // Types only at the top: the pdf.js chunk loads when a preview mounts.
    expect(CANVAS).not.toMatch(/^import \{[^}]*\} from 'unpdf\/pdfjs'/m)
    expect(CANVAS).toContain("import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'unpdf/pdfjs'")
  })

  it('swaps a finished drawing in at once, so an edit never blanks the page', () => {
    expect(CANVAS).toContain('target.replaceChildren(...canvases)')
  })

  it('answers false on the server and during hydration', () => {
    expect(CANVAS).toContain('useSyncExternalStore(noSubscribe, () => drawsPdfInPage(), () => false)')
  })

  it('masks the drawn invoice in session replay', () => {
    expect(CANVAS).toContain('data-ph-mask=""')
  })
})

describe('invoice PDF previews', () => {
  it('the editor pane draws in the page where the browser would show a blank <object>', () => {
    expect(PANE).toContain('const drawsInPage = useDrawsPdfInPage()')
    expect(PANE).toContain('{visible && drawsInPage ? (')
    expect(PANE).toContain('<PdfCanvasPreview url={target ?? visible} fit={zoom}')
    // The <object> path stays for the other browsers.
    expect(PANE).toContain('type="application/pdf"')
  })

  it('the settings preview does the same, with its fallback link', () => {
    expect(CARD).toContain('const drawsInPage = useDrawsPdfInPage()')
    expect(CARD).toContain('blobUrl && drawsInPage && (')
    expect(CARD).toContain('blobUrl && !drawsInPage && (')
    expect(CARD).toContain('type="application/pdf"')
  })
})
