'use client'

import type { ReactNode } from 'react'
import type { DocumentPreviewKind } from '@/lib/documents/preview-kind'
import { cn } from '@/lib/utils'

interface DocumentPreviewProps {
  /** What the browser loads: the same-origin inline proxy or a signed URL. */
  src: string
  kind: DocumentPreviewKind | null
  /** The accessible name: the file name, or a generic "underlag". */
  label: string
  /** Shown when the kind cannot be previewed, or inside a PDF the browser cannot render. */
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
 * invokes the PDF plugin directly. Sender HTML (mail underlag) is arbitrary
 * markup: a sandboxed frame with no tokens gives it an opaque origin, no
 * scripts, forms or popups, on the white canvas mail assumes.
 */
export function DocumentPreview({ src, kind, label, fallback, className, imageClassName }: DocumentPreviewProps) {
  if (kind === 'pdf') {
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
