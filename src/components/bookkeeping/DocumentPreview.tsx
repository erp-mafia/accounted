'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { PdfCanvasPreview, useDrawsPdfInPage } from '@/components/invoices/PdfCanvasPreview'
import { Skeleton } from '@/components/ui/skeleton'
import { pdfBytesUrl, readPdfForDrawing } from '@/lib/browser/pdf-embed'
import type { DocumentPreviewKind } from '@/lib/documents/preview-kind'
import { cn } from '@/lib/utils'

interface DocumentPreviewProps {
  /** What the browser loads: the same-origin inline proxy or a signed URL. */
  src: string
  kind: DocumentPreviewKind | null
  /** The accessible name: the file name, or a generic "underlag". */
  label: string
  /**
   * Shown when the kind cannot be previewed, inside a PDF the browser cannot
   * render, or in place of a PDF the page could not read or draw.
   */
  fallback: ReactNode
  /** The frame's size and border (PDF and HTML), or the image's when imageClassName is absent. */
  className?: string
  imageClassName?: string
}

/**
 * The body of every document viewer: the stored file itself, rendered by its
 * kind. The surrounding chrome (file name, open in a new tab, replace, the
 * locked-document rules) stays with each surface.
 *
 * PDFs use <object type="application/pdf">, not <iframe> or <embed>: Chrome
 * intermittently answers a framed PDF with "Det här innehållet har
 * blockerats" even under a permissive CSP (crbug.com/271452), while <object>
 * invokes the PDF plugin directly. Where an <object> shows no PDF (Chrome on
 * Android has no viewer and leaves it empty; a browser on an iPhone or iPad
 * shows the first page only), the page draws every page itself instead
 * (lib/browser/pdf-embed). Sender HTML (mail underlag) is arbitrary
 * markup: a sandboxed frame with no tokens gives it an opaque origin, no
 * scripts, forms or popups, on the white canvas mail assumes.
 */
export function DocumentPreview({ src, kind, label, fallback, className, imageClassName }: DocumentPreviewProps) {
  const drawsInPage = useDrawsPdfInPage()
  if (kind === 'pdf') {
    if (drawsInPage) return <DrawnPdf src={src} label={label} fallback={fallback} className={className} />
    return (
      <object data={src} type="application/pdf" aria-label={label} className={className}>
        {fallback}
      </object>
    )
  }
  if (kind === 'image') {
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin file behind auth, not a static asset
    return <img src={src} alt={label} className={imageClassName ?? className} />
  }
  if (kind === 'html') {
    return <iframe src={src} sandbox="" title={label} className={cn('border-0 bg-white', className)} />
  }
  return <>{fallback}</>
}

/**
 * The stored PDF drawn by the page, every page as wide as the frame and
 * scrolling down, from bytes read the way the <object> would load them. A
 * file that cannot be read or drawn shows the surface's fallback (its link to
 * open the file), never an empty frame.
 */
function DrawnPdf({ src, label, fallback, className }: Pick<DocumentPreviewProps, 'src' | 'label' | 'fallback' | 'className'>) {
  // A page jump (#page=2) changes src, not the file: it is read once.
  const url = pdfBytesUrl(src)
  const [read, setRead] = useState<{ url: string; file: Blob | null } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void readPdfForDrawing(url, controller.signal).then((file) => {
      if (!controller.signal.aborted) setRead({ url, file })
    })
    return () => controller.abort()
  }, [url])

  const current = read?.url === url ? read : null
  if (!current) {
    return (
      <div role="img" aria-label={label} aria-busy="true" className={cn('relative', className)}>
        <Skeleton className="absolute inset-0 h-full w-full rounded-lg" />
      </div>
    )
  }
  if (!current.file) return <div className={className}>{fallback}</div>
  return <PdfCanvasPreview file={current.file} fit="width" title={label} className={className} fallback={fallback} />
}
