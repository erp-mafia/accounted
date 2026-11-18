/**
 * How a stored document can be shown inline: a PDF in the browser's PDF
 * plugin, an image, sender HTML (mail underlag) in a sandboxed frame, or not
 * at all (a download link instead). One answer for every viewer: the copies
 * disagreed on legacy rows, where mime_type is null or
 * application/octet-stream and only the file name tells.
 */
export type DocumentPreviewKind = 'pdf' | 'image' | 'html'

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|svg|heic|heif)$/i

// Legacy uploads, and browsers that failed to sniff, left the type unset.
const typeUnrecorded = (mime: string | null | undefined): boolean =>
  mime == null || mime === '' || mime === 'application/octet-stream'

export function documentPreviewKind(
  mime: string | null | undefined,
  fileName?: string | null,
): DocumentPreviewKind | null {
  if (mime === 'application/pdf') return 'pdf'
  if (mime?.startsWith('image/')) return 'image'
  if (mime === 'text/html') return 'html'
  if (typeUnrecorded(mime)) {
    const name = fileName ?? ''
    if (name.toLowerCase().endsWith('.pdf')) return 'pdf'
    if (IMAGE_NAME.test(name)) return 'image'
  }
  return null
}

/**
 * A type was recorded and no viewer can draw it (a spreadsheet, a Word file,
 * a CSV): a surface that knows only the type says so and offers the file,
 * instead of handing it to the PDF plugin. An unrecorded type is not this:
 * it is still shown as the PDF or photo it most likely is.
 */
export function isUnpreviewableType(mime: string | null | undefined): boolean {
  return !typeUnrecorded(mime) && documentPreviewKind(mime) === null
}
