/**
 * Whether a PDF preview has to be drawn by the page itself (pdf.js on a
 * canvas) instead of handed to the browser's viewer in an
 * `<object type="application/pdf">` (crm#1689, accounted#178).
 *
 * The invoice previews load the PDF the server rendered as a blob: URL into
 * an `<object>`. Chrome, Edge and Firefox on a computer paint it with their
 * built-in viewer. WebKit does not: Safari on a Mac left the invoice editor's
 * Faktura pane blank, and every browser on an iPhone or iPad is WebKit
 * (Chrome there says CriOS, Edge EdgiOS, Firefox FxiOS, none of them
 * Chrome/). A browser that reports it has no PDF viewer at all
 * (`navigator.pdfViewerEnabled === false`: Chrome on Android, a viewer turned
 * off in settings) shows nothing in an `<object>` either.
 *
 * Those get the page's own drawing, the pdf.js renderer the signing page
 * already uses on the same browsers (components/signing/SigningDocument.tsx).
 * Everything else keeps the `<object>`, so the browsers where it works keep
 * their native viewer.
 */
export function drawsPdfInPage(
  userAgent: string | null | undefined = typeof navigator === 'undefined' ? null : navigator.userAgent,
  pdfViewerEnabled: boolean | undefined = typeof navigator === 'undefined' ? undefined : navigator.pdfViewerEnabled,
): boolean {
  if (pdfViewerEnabled === false) return true
  if (!userAgent) return false
  // WebKit without Blink: Blink browsers carry "AppleWebKit" too, but always
  // with a Chrome/ (or Chromium/, Edg/) token.
  return /AppleWebKit\//.test(userAgent) && !/(?:Chrome|Chromium|Edg)\//.test(userAgent)
}

/**
 * The address a drawn PDF's bytes are read from: the URL without its
 * #fragment. `#page=2` and `#toolbar=0&view=FitH` are instructions to the
 * browser's own viewer, which the page's drawing does not have, and a page
 * jump must not read the same file again.
 */
export function pdfBytesUrl(src: string): string {
  const hash = src.indexOf('#')
  return hash === -1 ? src : src.slice(0, hash)
}

/**
 * A stored PDF's bytes for the page's own drawing, read the way the
 * `<object>` it replaces loads them: the session cookie on the app's own
 * routes (the /api/documents/:id/inline proxy, an invoice's archived PDF),
 * none on a signed Storage URL, which carries its own token. Null when the
 * file could not be read; the caller then shows its link to open the file
 * instead.
 */
export async function readPdfForDrawing(src: string, signal?: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(pdfBytesUrl(src), { credentials: 'same-origin', signal })
    // A refused read answers with a JSON error envelope: never hand that to pdf.js.
    if (!res.ok) return null
    return await res.blob()
  } catch {
    // The network failed or the viewer closed (an aborted read): the person
    // gets the link to open the file, which reports its own failure.
    return null
  }
}
