import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildContentSecurityPolicy } from '@/lib/security/csp'

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
const HOOK = read('../editor/use-editor-previews.ts')
const CARD = read('../../settings/InvoicePreviewCard.tsx')
const DOCUMENT = read('../../bookkeeping/DocumentPreview.tsx')

/** The sources the app's page policy allows for fetch(), XHR and sockets. */
function connectSources(): string[] {
  const policy = buildContentSecurityPolicy({
    origins: { supabaseUrl: 'https://project.supabase.co', supabaseWsUrl: 'wss://project.supabase.co', turnstile: false },
    nonce: 'bm9uY2U=',
    isDev: false,
  })
  const directive = policy.split('; ').find((part) => part.startsWith('connect-src '))
  return directive ? directive.split(' ').slice(1) : []
}

describe('PdfCanvasPreview', () => {
  it('reads the PDF from the Blob it is handed, never by fetching its blob: URL', () => {
    // The first version fetched the blob: URL back. connect-src has no blob:,
    // so Safari ("Load failed") and Chrome ("Failed to fetch") refused it and
    // the Safari preview stayed blank after the fix had shipped.
    expect(connectSources()).not.toContain('blob:')
    expect(CANVAS).toContain('file.arrayBuffer()')
    expect(CANVAS).not.toMatch(/\bfetch\(/)
  })

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
    expect(PANE).toContain('{visible && drawsInPage && pdf.blob ? (')
    expect(PANE).toContain('file={pdf.blob}')
    // The render's bytes travel with its URL.
    expect(HOOK).toContain('setResult({ url, blob, renderedBody: body, ...meta })')
    // The <object> path stays for the other browsers.
    expect(PANE).toContain('type="application/pdf"')
  })

  it('the editor pane says so and links the PDF when pdf.js cannot draw it, never a blank box', () => {
    expect(PANE).toMatch(/fallback=\{\s*<p[^>]*>\s*\{t\('preview_not_drawn'\)\}/)
    expect(PANE).toContain("{t('preview_open')}")
    for (const locale of ['sv', 'en']) {
      const messages = JSON.parse(read(`../../../messages/${locale}.json`)) as Record<string, Record<string, string>>
      expect(messages.invoice_editor_shell.preview_not_drawn).toBeTruthy()
    }
  })

  it('the settings preview does the same, with its fallback link', () => {
    expect(CARD).toContain('const drawsInPage = useDrawsPdfInPage()')
    expect(CARD).toContain('blobUrl && pdfBlob && drawsInPage && (')
    expect(CARD).toContain('file={pdfBlob}')
    expect(CARD).toContain('setPdfBlob(blob)')
    expect(CARD).toContain('blobUrl && !drawsInPage && (')
    expect(CARD).toContain('type="application/pdf"')
  })
})

describe('stored document PDFs (DocumentPreview)', () => {
  it('draws every page in the page where the <object> shows nothing or only page 1', () => {
    // Chrome on Android left the Inkorg document and a sent invoice's file an
    // empty white sheet; an iPhone showed the first page only.
    expect(DOCUMENT).toContain('const drawsInPage = useDrawsPdfInPage()')
    expect(DOCUMENT).toContain('if (drawsInPage) return <DrawnPdf')
    expect(DOCUMENT).toContain('fit="width"')
    // The bytes are handed over as a Blob, read from the file's own address.
    expect(DOCUMENT).toContain('readPdfForDrawing(url, controller.signal)')
    expect(DOCUMENT).toContain('file={current.file}')
  })

  it('shows the surface\'s link when the file cannot be read or drawn, never an empty frame', () => {
    expect(DOCUMENT).toContain('if (!current.file) return <div className={className}>{fallback}</div>')
    expect(DOCUMENT).toMatch(/<PdfCanvasPreview[^>]*fallback=\{fallback\}/)
  })

  it('keeps the browser viewer, an <object>, everywhere it draws the PDF', () => {
    expect(DOCUMENT).toContain('<object data={src} type="application/pdf"')
  })
})
