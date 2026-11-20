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
